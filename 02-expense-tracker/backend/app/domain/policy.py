RECEIPT_THRESHOLD_BASE_MINOR = 2500


def requires_receipt(base_amount_minor: int) -> bool:
    """Lines at or above the threshold, in base-currency minor units, need a receipt."""
    return base_amount_minor >= RECEIPT_THRESHOLD_BASE_MINOR
