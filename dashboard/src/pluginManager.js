// Plugin Manager — Lightweight plugin system for chat commands
const plugins = new Map();

export function registerPlugin(name, config) {
  if (plugins.has(name)) {
    console.warn(`Plugin "${name}" already registered, overwriting.`);
  }
  plugins.set(name, {
    name,
    description: config.description || '',
    commands: config.commands || {},
    onMessage: config.onMessage || null,
    onInit: config.onInit || null,
  });
  if (config.onInit) config.onInit();
}

export function unregisterPlugin(name) {
  plugins.delete(name);
}

export function getPlugins() {
  return Array.from(plugins.values());
}

export function getCommands() {
  const cmds = [];
  for (const [, plugin] of plugins) {
    for (const [cmd, handler] of Object.entries(plugin.commands)) {
      cmds.push({ command: cmd, description: handler.description || '', plugin: plugin.name, execute: handler.execute });
    }
  }
  return cmds;
}

export function executeCommand(input) {
  if (!input.startsWith('/')) return null;
  const parts = input.slice(1).split(/\s+/);
  const cmdName = parts[0];
  const args = parts.slice(1).join(' ');

  for (const [, plugin] of plugins) {
    if (plugin.commands[cmdName]) {
      return plugin.commands[cmdName].execute(args);
    }
  }
  return null;
}

// Built-in plugins
registerPlugin('builtins', {
  description: 'Built-in chat commands',
  commands: {
    help: {
      description: 'Show available commands',
      execute: () => {
        const cmds = getCommands();
        return {
          type: 'system',
          content: '**Available Commands:**\n' + cmds.map(c => `- \`/${c.command}\` — ${c.description}`).join('\n'),
        };
      },
    },
    clear: {
      description: 'Clear current conversation',
      execute: () => {
        return { type: 'action', action: 'clear' };
      },
    },
    stats: {
      description: 'Show session statistics',
      execute: () => {
        return { type: 'action', action: 'stats' };
      },
    },
    mode: {
      description: 'Switch cloud provider (enowxai/openai/anthropic)',
      execute: (args) => {
        const mode = args.trim();
        if (!['enowxai', 'openai', 'anthropic'].includes(mode)) {
          return { type: 'system', content: 'Usage: `/mode enowxai`, `/mode openai`, or `/mode anthropic`' };
        }
        return { type: 'action', action: 'switch-mode', data: mode };
      },
    },
  },
});
