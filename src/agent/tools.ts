/** Ollama function tools exposed to the assistant. Mutating tools require an explicit UI confirmation. */
export const ASSISTANT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web for current information. Returns titles, URLs and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Read the main readable text of a public HTTP or HTTPS webpage, stripping scripts, navigation, and other boilerplate.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public webpage URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_path',
      description: 'List a local directory or read a local text file. This is read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute filesystem path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        'Run a command in the local user shell. The user will see the exact command and working directory and must approve it before it runs. Do not use sudo unless the user explicitly requests it.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
      },
    },
  },
] as const
