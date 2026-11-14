from rest_framework import exceptions

from core.errors import InvalidState, exception_handler, flatten_errors


def test_flatten_errors_builds_dotted_paths_for_nested_lists():
    detail = {
        "email": ["Enter a valid email address."],
        "lines": [{}, {"quantity": ["Ensure this value is less than or equal to 999."]}],
        "non_field_errors": ["Something about the whole body."],
    }

    assert flatten_errors(detail) == [
        {"path": "email", "message": "Enter a valid email address."},
        {"path": "lines.1.quantity", "message": "Ensure this value is less than or equal to 999."},
        {"path": "", "message": "Something about the whole body."},
    ]


def test_flatten_errors_handles_list_field_index_dicts():
    detail = {"lines": {0: {"sku": ["This field is required."]}}}

    assert flatten_errors(detail) == [{"path": "lines.0.sku", "message": "This field is required."}]


def test_domain_error_is_rendered_in_the_envelope():
    response = exception_handler(InvalidState(details={"status": "paid"}), {})

    assert response.status_code == 409
    assert response.data["error"]["code"] == "invalid_state"
    assert response.data["error"]["details"] == {"status": "paid"}
    assert "requestId" in response.data["error"]


def test_validation_error_uses_validation_failed_code():
    response = exception_handler(exceptions.ValidationError({"name": ["Required."]}), {})

    assert response.status_code == 400
    assert response.data["error"]["code"] == "validation_failed"
    assert response.data["error"]["details"]["fields"] == [{"path": "name", "message": "Required."}]


def test_unexpected_exception_is_hidden_behind_internal_error():
    response = exception_handler(RuntimeError("database password is hunter2"), {})

    assert response.status_code == 500
    assert response.data["error"]["code"] == "internal_error"
    assert "hunter2" not in response.data["error"]["message"]
