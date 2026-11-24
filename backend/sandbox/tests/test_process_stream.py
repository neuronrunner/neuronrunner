"""Carriage-return progress is delivered before process exit, without secrets."""
from io import BytesIO
from unittest import TestCase

from sandbox.services.process_stream import process_output


class ProcessStreamTests(TestCase):
    def test_available_bytes_are_read_without_waiting_for_newline(self):
        class Stream:
            calls = 0
            def read1(self, size):
                self.calls += 1
                return [b"Receiving objects: 25%\r", b"Receiving objects: 75%\r", b"Done\n", b""][self.calls - 1]
            def __iter__(self):
                raise AssertionError("Line iteration buffers carriage-return progress")
        stream = Stream()
        output = process_output(stream)
        self.assertEqual(next(output), "Receiving objects: 25%\r")
        self.assertEqual(stream.calls, 1)
        self.assertEqual(next(output), "Receiving objects: 75%\r")
        self.assertEqual("".join(output), "Done\n")

    def test_secret_split_across_chunks_is_redacted(self):
        for split in range(1, len("private-test-token")):
            secret = "private-test-token"
            output = list(process_output(iter([("progress " + secret[:split]).encode(), (secret[split:] + " done\n").encode()]), secret))
            self.assertEqual("".join(output), "progress ****** done\n")
            self.assertNotIn(secret, "".join(output))

    def test_split_utf8_and_string_output_remain_readable(self):
        encoded = "Klonlandı\n".encode()
        self.assertEqual("".join(process_output(iter([encoded[:8], encoded[8:]]))), "Klonlandı\n")
        self.assertEqual("".join(process_output(iter(["Downloading\r", "Complete\n"]))), "Downloading\rComplete\n")
        self.assertEqual("".join(process_output(BytesIO(b"test\n"))), "test\n")
