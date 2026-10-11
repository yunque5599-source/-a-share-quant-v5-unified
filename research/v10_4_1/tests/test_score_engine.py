from research.v10_4_1.score_engine import calculate_score, rating


def test_high_score():
    score = calculate_score(90, 90, 90, 90)
    assert score == 90
    assert rating(score) == "A+"


def test_low_score():
    score = calculate_score(50, 50, 50, 50)
    assert rating(score) == "C"
