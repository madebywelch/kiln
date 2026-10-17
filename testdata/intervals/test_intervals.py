import unittest

from intervals import merge_intervals


class MergeIntervalsTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(merge_intervals([]), [])

    def test_single(self):
        self.assertEqual(merge_intervals([[1, 3]]), [[1, 3]])

    def test_overlap_and_unsorted(self):
        self.assertEqual(
            merge_intervals([[8, 10], [2, 6], [1, 3], [15, 18]]),
            [[1, 6], [8, 10], [15, 18]],
        )

    def test_touching(self):
        self.assertEqual(merge_intervals([[1, 4], [4, 5]]), [[1, 5]])

    def test_nested_duplicates_and_negatives(self):
        self.assertEqual(
            merge_intervals([[1, 10], [2, 3], [1, 10], [-5, -1], [-2, 0]]),
            [[-5, 0], [1, 10]],
        )

    def test_point_intervals(self):
        self.assertEqual(merge_intervals([[2, 2], [1, 1]]), [[1, 1], [2, 2]])

    def test_does_not_mutate_input(self):
        original = [[4, 6], [1, 5]]
        snapshot = [pair[:] for pair in original]
        merge_intervals(original)
        self.assertEqual(original, snapshot)

    def test_returns_independent_lists(self):
        original = [[1, 2]]
        merged = merge_intervals(original)
        merged[0][0] = 99
        self.assertEqual(original, [[1, 2]])


if __name__ == "__main__":
    unittest.main()
