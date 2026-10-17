import unittest

from scripts.token_counter_service import CountRequest, count_tokens, encoding_for_model


class LiteralTextCountTest(unittest.TestCase):
    def test_reserved_markers_are_counted_as_literal_text(self):
        for model in ("gpt-4o", "gpt-4"):
            encoding = encoding_for_model(model)
            for marker in encoding.special_tokens_set:
                with self.subTest(model=model, marker=marker):
                    text = f"hello {marker} world"
                    result = count_tokens(CountRequest(model=model, text=text))
                    self.assertEqual(result.tokens, len(encoding.encode(text, disallowed_special=())))

    def test_regular_text_counts_are_unchanged(self):
        for text in ("hello world", "中文正文", "", "1234567890" * 100):
            with self.subTest(text=text[:20]):
                result = count_tokens(CountRequest(model="gpt-4o", text=text))
                self.assertEqual(result.tokens, len(encoding_for_model("gpt-4o").encode(text)))


if __name__ == "__main__":
    unittest.main()
