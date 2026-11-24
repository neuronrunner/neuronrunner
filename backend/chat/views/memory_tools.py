"""REST adapters for the same memory/note services used by model tools."""
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from chat.services.memory_service import MemoryService, NoteService, StoreError, serialize


def store_response(request, kind, action):
    data = request.query_params if request.method == 'GET' else request.data
    try:
        service = (MemoryService if kind == 'memory' else NoteService)(
            request.user, sandbox_uuid=data.get('sandbox_uuid'), workspace_uuid=data.get('workspace_uuid'),
        )
        if action == 'add':
            record, created = service.create(data)
            return Response(serialize(record), status=201 if created else 200)
        if action == 'replace':
            values = dict(data)
            values['content'] = data.get('new_content')
            return Response(serialize(service.update(values)))
        if action == 'remove':
            return Response({'success': True, 'removed_uuid': service.remove(data)})
        records = service.search(data) if action == 'search' else service.list(data)
        records = [serialize(record) for record in records]
        return Response({'count': len(records), 'memories' if kind == 'memory' else 'notes': records})
    except StoreError as exc:
        return Response(exc.as_dict(), status=exc.status)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def memory_add(request):
    return store_response(request, 'memory', 'add')


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def memory_replace(request):
    return store_response(request, 'memory', 'replace')


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def memory_remove(request):
    return store_response(request, 'memory', 'remove')


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def memory_list(request):
    return store_response(request, 'memory', 'list')


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def note_add(request):
    return store_response(request, 'note', 'add')


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def note_replace(request):
    return store_response(request, 'note', 'replace')


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def note_remove(request):
    return store_response(request, 'note', 'remove')


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def note_list(request):
    return store_response(request, 'note', 'list')
