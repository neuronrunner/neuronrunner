"""Canonical memory schemas for both database and legacy tool definitions."""
from copy import deepcopy


def normalize_store_schema(name, parameters):
    parameters = deepcopy(parameters)
    if not name.startswith(('memory_', 'note_')):
        return parameters
    properties = parameters.setdefault('properties', {})
    if name.startswith('memory_') and 'category' in properties:
        properties['category']['enum'] = ['identity', 'preference', 'workspace', 'knowledge', 'relationship']
    if 'importance_score' in properties:
        properties['importance_score']['description'] = 'Importance 1-10, used with relevance and recency when ranking.'
    if name.endswith(('_replace', '_remove')):
        properties['uuid'] = {'type': 'string', 'format': 'uuid', 'description': 'Record UUID from list/search; preferred over old_text.'}
        parameters['required'] = [key for key in parameters.get('required', []) if key != 'old_text']
        parameters['anyOf'] = [{'required': ['uuid']}, {'required': ['old_text']}]
    return parameters
