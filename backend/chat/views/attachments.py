"""
Attachment download views.
"""

from django.http import FileResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from chat.models import MessageAttachment


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def download_attachment(request, attachment_id):
    """Download a message attachment if the requester owns the conversation."""
    attachment = get_object_or_404(
        MessageAttachment.objects.select_related('message__conversation__user'),
        uuid=attachment_id,
    )

    conversation = attachment.message.conversation
    can_access = conversation.user == request.user or conversation.workspaces.filter(
        workspace__memberships__user=request.user
    ).exists()
    if not can_access:
        return Response({"message": "Not found"}, status=status.HTTP_404_NOT_FOUND)

    response = FileResponse(attachment.file.open('rb'), as_attachment=True, filename=attachment.original_name)
    if attachment.content_type:
        response['Content-Type'] = attachment.content_type
    return response
