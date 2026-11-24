"""User management endpoints remain available when personal memory is off."""
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from chat.services.memory_service import MemoryService, StoreError, serialize


@api_view(['GET', 'POST'])
@permission_classes([permissions.IsAuthenticated])
def list_memories(request):
    service = MemoryService(request.user, management=True)
    if request.method == 'POST':
        try:
            record, created = service.create(request.data)
            return Response({**serialize(record), 'created': created}, status=201 if created else 200)
        except StoreError as exc:
            return Response(exc.as_dict(), status=exc.status)
    query = (request.query_params.get('query') or '').strip()
    if query:
        try:
            records = service.search({'query': query, 'limit': 20}, touch=False)
            return Response([serialize(record) for record in records])
        except StoreError as exc:
            return Response(exc.as_dict(), status=exc.status)
    return Response([serialize(record) for record in service.list(request.query_params)])


@api_view(['PATCH'])
@permission_classes([permissions.IsAuthenticated])
def update_memory(request, memory_id):
    try:
        service = MemoryService(request.user, management=True)
        return Response(serialize(service.update({**request.data, 'uuid': str(memory_id)})))
    except StoreError as exc:
        return Response(exc.as_dict(), status=exc.status)


@api_view(['DELETE'])
@permission_classes([permissions.IsAuthenticated])
def delete_memory(request, memory_id):
    try:
        MemoryService(request.user, management=True).remove({'uuid': str(memory_id)})
        return Response({'success': True})
    except StoreError as exc:
        return Response(exc.as_dict(), status=exc.status)


@api_view(['DELETE'])
@permission_classes([permissions.IsAuthenticated])
def delete_all_memories(request):
    count, _ = MemoryService(request.user, management=True).queryset().delete()
    return Response({'success': True, 'deleted': count})
