from django.http import HttpRequest, JsonResponse

from .errors import current_request_id, envelope


def not_found(request: HttpRequest, exception: Exception) -> JsonResponse:
    message = "The requested resource was not found."
    return JsonResponse(envelope("not_found", message, None, current_request_id()), status=404)


def server_error(request: HttpRequest) -> JsonResponse:
    message = "An unexpected error occurred."
    return JsonResponse(envelope("internal_error", message, None, current_request_id()), status=500)
