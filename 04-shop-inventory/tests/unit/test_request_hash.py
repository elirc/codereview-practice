import json

import pytest

from core.errors import ValidationFailed
from core.idempotency import IdempotencyKeyRequired, canonical_json, request_hash, require_key


def test_key_order_does_not_change_the_hash():
    first = {"email": "a@example.com", "lines": [{"sku": "A", "quantity": 1}]}
    second = {"lines": [{"quantity": 1, "sku": "A"}], "email": "a@example.com"}

    assert request_hash(first) == request_hash(second)


def test_whitespace_in_the_original_body_does_not_matter():
    compact = json.loads('{"a":1,"b":[1,2]}')
    spaced = json.loads('{\n  "b": [1, 2],\n  "a": 1\n}')

    assert request_hash(compact) == request_hash(spaced)


def test_list_order_and_values_do_change_the_hash():
    base = {"lines": [{"sku": "A", "quantity": 1}, {"sku": "B", "quantity": 1}]}
    reordered = {"lines": [{"sku": "B", "quantity": 1}, {"sku": "A", "quantity": 1}]}
    changed = {"lines": [{"sku": "A", "quantity": 2}, {"sku": "B", "quantity": 1}]}

    assert request_hash(base) != request_hash(reordered)
    assert request_hash(base) != request_hash(changed)


def test_canonical_json_is_compact_sorted_and_keeps_unicode():
    assert canonical_json({"b": "é", "a": [1, None]}) == '{"a":[1,null],"b":"é"}'


def test_number_types_are_distinguished():
    assert request_hash({"amount_minor": 1}) != request_hash({"amount_minor": "1"})


def test_hash_is_hex_sha256():
    digest = request_hash({})

    assert len(digest) == 64
    int(digest, 16)


@pytest.mark.parametrize("value", [None, ""])
def test_missing_key_is_required(value):
    with pytest.raises(IdempotencyKeyRequired):
        require_key(value)


@pytest.mark.parametrize("value", ["short", "x" * 129, "tab\there!"])
def test_malformed_keys_are_rejected(value):
    with pytest.raises(ValidationFailed):
        require_key(value)


@pytest.mark.parametrize("value", ["12345678", "k" * 128])
def test_keys_at_the_length_limits_are_accepted(value):
    assert require_key(value) == value
