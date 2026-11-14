from orders.services import LineRequest, merge_lines


def test_duplicate_skus_are_summed_in_first_seen_order():
    merged = merge_lines(
        [
            LineRequest(sku="B", quantity=1),
            LineRequest(sku="A", quantity=2),
            LineRequest(sku="B", quantity=3),
        ]
    )

    assert merged == [LineRequest(sku="B", quantity=4), LineRequest(sku="A", quantity=2)]


def test_distinct_skus_are_left_alone():
    lines = [LineRequest(sku="A", quantity=1), LineRequest(sku="B", quantity=1)]

    assert merge_lines(lines) == lines
