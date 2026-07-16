from django.http import JsonResponse

from .models import Widget


def index(_request):
    # Touch the database so a broken DB connection surfaces immediately.
    count = Widget.objects.count()
    return JsonResponse({"message": "hello from the ORCA django app", "widgets": count})
