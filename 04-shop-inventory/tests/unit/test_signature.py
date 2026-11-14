import hashlib
import hmac
import json

import pytest

from payments.exceptions import InvalidSignature
from payments.signature import build_header, parse_header, sign, verify

SECRET = "whsec_current_secret"
PREVIOUS = "whsec_previous_secret"
NOW = 1_772_452_800
BODY = b'{"id": "evt_1", "type": "payment.succeeded", "created": 1772452800, "data": {}}'


def check(header, body=BODY, *, secrets=(SECRET,), now=NOW):
    verify(header, body, secrets=secrets, now=now)


def test_sign_matches_hmac_sha256_over_timestamp_dot_body():
    expected = hmac.new(SECRET.encode(), b"1772452800." + BODY, hashlib.sha256).hexdigest()

    assert sign(SECRET, "1772452800", BODY) == expected


def test_valid_signature_is_accepted():
    check(build_header(SECRET, NOW, BODY))


def test_signature_made_with_another_secret_is_rejected():
    with pytest.raises(InvalidSignature):
        check(build_header("whsec_someone_else", NOW, BODY))


def test_previous_secret_is_accepted_during_rotation():
    check(build_header(PREVIOUS, NOW, BODY), secrets=(SECRET, PREVIOUS))


def test_previous_secret_is_rejected_once_it_is_no_longer_configured():
    with pytest.raises(InvalidSignature):
        check(build_header(PREVIOUS, NOW, BODY), secrets=(SECRET, ""))


@pytest.mark.parametrize("offset", [-300, 300, 0])
def test_timestamps_within_tolerance_are_accepted(offset):
    check(build_header(SECRET, NOW + offset, BODY))


@pytest.mark.parametrize("offset", [-301, 301, -86_400])
def test_timestamps_outside_tolerance_are_rejected(offset):
    with pytest.raises(InvalidSignature):
        check(build_header(SECRET, NOW + offset, BODY))


def test_one_matching_signature_among_several_is_enough():
    good = sign(SECRET, str(NOW), BODY)

    check(f"t={NOW},v1={'0' * 64},v1={good},v0=legacy")


def test_reserialised_json_does_not_verify():
    header = build_header(SECRET, NOW, BODY)
    reserialised = json.dumps(json.loads(BODY), separators=(",", ":")).encode()

    with pytest.raises(InvalidSignature):
        check(header, reserialised)


def test_a_single_changed_byte_does_not_verify():
    header = build_header(SECRET, NOW, BODY)

    with pytest.raises(InvalidSignature):
        check(header, BODY.replace(b"evt_1", b"evt_2"))


def test_signature_is_bound_to_the_timestamp():
    good = sign(SECRET, str(NOW), BODY)

    with pytest.raises(InvalidSignature):
        check(f"t={NOW + 1},v1={good}")


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "garbage",
        f"v1={'a' * 64}",
        f"t={NOW}",
        f"t=,v1={'a' * 64}",
        f"t=12a,v1={'a' * 64}",
        f"t={NOW},t={NOW},v1={'a' * 64}",
        f"t={NOW},,v1={'a' * 64}",
        f"t=١٢,v1={'a' * 64}",
    ],
)
def test_malformed_headers_are_rejected(header):
    with pytest.raises(InvalidSignature):
        check(header)


def test_parse_header_tolerates_spaces_and_unknown_schemes():
    assert parse_header(f"t={NOW}, v1=abc, v0=def , v1=ghi") == (str(NOW), ["abc", "ghi"])


def test_non_ascii_signature_values_are_rejected_without_error():
    with pytest.raises(InvalidSignature):
        check(f"t={NOW},v1=café")
