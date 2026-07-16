from django.db import models


class Widget(models.Model):
    """One tiny model so the Postgres connection + migrations are actually exercised."""

    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name
