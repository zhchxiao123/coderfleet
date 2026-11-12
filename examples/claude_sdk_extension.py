"""Copy into a project and select extension.path in SDK parameters.

Runs in that account's SDK worker, with its existing filesystem permissions.
Never put credentials in Task parameters. Use account environment instead.
"""
from claude_agent_sdk import HookMatcher, create_sdk_mcp_server, tool


def create(context):
    @tool('echo', 'Return a supplied marker unchanged', {'marker': str})
    async def echo(arguments):
        return {'content':[{'type':'text','text':arguments['marker']}]}

    async def observe_tool(input, tool_use_id, hook_context):
        context['emit']({'type':'system','subtype':'hook_progress',
                         'hook_name':'project observer','task_id':context['task_id']})
        return {}  # No permission opinion. Keep CoderFleet's approval callback.

    return {
        'hooks':{'PreToolUse':[HookMatcher(hooks=[observe_tool],timeout=5,on_failure='continue')]},
        'mcp_servers':{'project_tools':create_sdk_mcp_server('project_tools',tools=[echo])},
    }
