from payments.client import PaymentsClient, RefundSubmission
from payments.provider import FakeProvider


def test_submit_refund_passes_the_amount_and_intent_to_the_provider():
    provider = FakeProvider()
    submission = RefundSubmission(
        refund_id="7d4c1d9e-3b55-4c3e-9f0c-2b6f3f1f2a10",
        payment_intent_id="pi_123",
        amount_minor=1500,
        attempt=1,
    )

    created = PaymentsClient(provider).submit_refund(submission)

    method, arguments = provider.calls[-1]
    assert method == "create_refund"
    assert (arguments["payment_intent_id"], arguments["amount_minor"]) == ("pi_123", 1500)
    assert created.id.startswith("re_")
