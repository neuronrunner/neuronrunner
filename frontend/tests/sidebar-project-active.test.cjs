const { test } = require('node:test');
const assert = require('node:assert/strict');

function computeProjectActive({ project, pathname, isExpanded, hasActiveChildConversation }) {
  const isDirectProjectRoute = (
    pathname === `/projects/${project.slug}` ||
    pathname === `/projects/${project.uuid}` ||
    pathname.startsWith(`/projects/${project.slug}/`) ||
    pathname.startsWith(`/projects/${project.uuid}/`)
  );
  return isDirectProjectRoute || (!isExpanded && hasActiveChildConversation);
}

function computeConversationActive({ isFileActive, isChatRoute, conversationUuid, activeConversationId }) {
  return !isFileActive && isChatRoute && conversationUuid === activeConversationId;
}

test('when viewing a conversation inside a project and project is open, only conversation is active', () => {
  const project = { uuid: 'proj-1', slug: 'demo-app', display_name: 'demo-app' };
  const conversationUuid = 'conv-1';
  const convIds = ['conv-1'];
  const pathname = `/chat/${conversationUuid}`;
  const isChatRoute = pathname.startsWith('/chat');
  const isFileActive = false;
  const isExpanded = true;

  const hasActiveChildConversation = !isFileActive && isChatRoute && convIds.includes(conversationUuid);
  const isProjectActive = computeProjectActive({ project, pathname, isExpanded, hasActiveChildConversation });
  const isConversationActive = computeConversationActive({
    isFileActive,
    isChatRoute,
    conversationUuid,
    activeConversationId: conversationUuid,
  });

  assert.equal(isProjectActive, false, 'Project header should not be active when open and child conversation is active');
  assert.equal(isConversationActive, true, 'Conversation item should be active');
});

test('when viewing a conversation inside a project and project is closed, project header appears active', () => {
  const project = { uuid: 'proj-1', slug: 'demo-app', display_name: 'demo-app' };
  const conversationUuid = 'conv-1';
  const convIds = ['conv-1'];
  const pathname = `/chat/${conversationUuid}`;
  const isChatRoute = pathname.startsWith('/chat');
  const isFileActive = false;
  const isExpanded = false;

  const hasActiveChildConversation = !isFileActive && isChatRoute && convIds.includes(conversationUuid);
  const isProjectActive = computeProjectActive({ project, pathname, isExpanded, hasActiveChildConversation });

  assert.equal(isProjectActive, true, 'Project header should appear active when collapsed and holding active conversation');
});

test('when viewing a project page, project header is active whether open or closed', () => {
  const project = { uuid: 'proj-1', slug: 'demo-app', display_name: 'demo-app' };
  const pathname = `/projects/${project.slug}`;
  const isChatRoute = pathname.startsWith('/chat');
  const isFileActive = false;

  const activeOpen = computeProjectActive({ project, pathname, isExpanded: true, hasActiveChildConversation: false });
  const activeClosed = computeProjectActive({ project, pathname, isExpanded: false, hasActiveChildConversation: false });
  const isConversationActive = computeConversationActive({
    isFileActive,
    isChatRoute,
    conversationUuid: 'conv-1',
    activeConversationId: 'conv-1',
  });

  assert.equal(activeOpen, true, 'Project header should be active on project page when open');
  assert.equal(activeClosed, true, 'Project header should be active on project page when closed');
  assert.equal(isConversationActive, false, 'Conversation item should not be active on project page');
});

test('when viewing another conversation, project header is not active even if closed', () => {
  const project = { uuid: 'proj-1', slug: 'demo-app', display_name: 'demo-app' };
  const conversationUuid = 'other-conv';
  const convIds = ['conv-1'];
  const pathname = `/chat/${conversationUuid}`;
  const isChatRoute = pathname.startsWith('/chat');
  const isFileActive = false;
  const isExpanded = false;

  const hasActiveChildConversation = !isFileActive && isChatRoute && convIds.includes(conversationUuid);
  const isProjectActive = computeProjectActive({ project, pathname, isExpanded, hasActiveChildConversation });

  assert.equal(isProjectActive, false, 'Project header should not be active when viewing unrelated conversation');
});
