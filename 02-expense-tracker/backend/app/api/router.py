from fastapi import APIRouter, Depends

from app.api import approvals, auth, health, rates, receipts, reports, users, workflow
from app.api.deps import require_csrf_header

api_router = APIRouter(prefix="/api", dependencies=[Depends(require_csrf_header)])
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(rates.router)
api_router.include_router(reports.router)
api_router.include_router(workflow.router)
api_router.include_router(receipts.router)
api_router.include_router(approvals.router)
