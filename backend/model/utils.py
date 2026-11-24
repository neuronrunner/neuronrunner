import os

from django.conf import settings


class ModelFileHandler:
    def __init__(self, model_file):
        self.model_file = model_file

    def delete_model_file(self):
        """Delete the specified model file from the volume."""
        file_path = os.path.join(settings.MODEL_STORE_PATH, self.model_file)
        if os.path.exists(file_path):
            os.remove(file_path)


def get_scaledown_window() -> int:
    from .models import SiteSetting
    return SiteSetting.get_singleton().scaledown_window
