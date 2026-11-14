import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiGet, apiSend } from "./client";
import { receiptSchema, reportDetailSchema, type ReportDetail } from "./schemas";

export function useReport(id: string) {
  return useQuery({
    queryKey: ["report", id],
    queryFn: () => apiGet(`/reports/${id}`, reportDetailSchema),
  });
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === "version_conflict";
}

/**
 * Runs a report mutation and stores the returned report. On a version conflict the
 * report is refetched so the caller can show the latest state.
 */
export function useReportAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: () => Promise<ReportDetail>) => action(),
    onSuccess: (report) => {
      queryClient.setQueryData(["report", id], report);
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["audit", id] });
    },
    onError: (error) => {
      if (isVersionConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: ["report", id] });
      }
    },
  });
}

export function postReport(path: string, body: unknown): Promise<ReportDetail> {
  return apiSend("POST", path, reportDetailSchema, body);
}

export function uploadReceipt(file: File) {
  const form = new FormData();
  form.append("file", file);
  return apiSend("POST", "/receipts", receiptSchema, form);
}
