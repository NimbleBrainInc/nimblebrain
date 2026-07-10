// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import starlightLinksValidator from 'starlight-links-validator';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.nimblebrain.ai',
  // Redirects for pages removed/merged in the architecture realignment, so
  // bookmarked and indexed URLs land on their replacements instead of 404ing.
  redirects: {
    '/api/overview': '/connect/mcp-endpoint/',
    '/api/mcp-endpoint': '/connect/mcp-endpoint/',
    '/api/authentication': '/config/instance-json/',
    '/api/bootstrap': '/connect/mcp-endpoint/',
    '/api/chat': '/connect/mcp-endpoint/',
    '/api/tools': '/connect/mcp-endpoint/',
    '/api/events': '/connect/mcp-endpoint/',
    '/api/health': '/deploy/observability/',
    '/guide/chat': '/using/chat/',
    '/guide/conversations': '/using/conversations/',
    '/guide/apps': '/using/installing-apps/',
    '/guide/files': '/using/file-context/',
    '/guide/workspaces': '/using/workspaces/',
    '/guide/team': '/using/users/',
    '/guide/mcp-connect': '/connect/external-clients/',
    '/cli/user': '/cli/overview/',
    '/cli/interactive': '/using/chat/',
    '/cli/bundle': '/using/managing-apps/',
    '/cli/skill': '/using/skills/',
    '/cli/config': '/config/credentials/',
    '/cli/credential': '/config/credentials/',
    '/cli/status': '/cli/overview/',
    '/cli/reload': '/cli/overview/',
    '/cli/telemetry': '/using/telemetry/',
    '/cli/automation': '/using/automations/',
  },
  integrations: [
    starlight({
      title: 'NimbleBrain',
      favicon: '/favicon.ico',
      logo: {
        light: './src/assets/logo-light.png',
        dark: './src/assets/logo-dark.png',
        alt: 'NimbleBrain',
        replacesTitle: true,
      },
      customCss: ['./src/styles/custom.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/NimbleBrainInc/nimblebrain' },
        { icon: 'discord', label: 'Discord', href: 'https://nimblebrain.ai/discord' },
        { icon: 'x.com', label: 'X', href: 'https://x.com/nimblebraininc' },
      ],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;0,7..72,700;1,7..72,400;1,7..72,500;1,7..72,600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Mono:wght@300;400;500&family=JetBrains+Mono:wght@400;500&display=swap',
          },
        },
      ],
      plugins: [
        starlightLinksValidator({ errorOnLocalLinks: false }),
        starlightSidebarTopics([
          {
            label: 'Getting Started',
            link: '/',
            icon: 'rocket',
            items: [
              { label: 'What is NimbleBrain?', slug: 'index' },
              { label: 'Quickstart', slug: 'quickstart' },
              { label: 'Installation', slug: 'installation' },
              { label: 'Core Concepts', slug: 'concepts' },
              { label: 'MCP Apps', slug: 'concepts/mcp-apps' },
            ],
          },
          {
            label: 'Using NimbleBrain',
            link: '/guide/welcome',
            icon: 'star',
            items: [
              {
                label: 'Interface tour',
                items: [
                  { label: 'Welcome', slug: 'guide/welcome' },
                  { label: 'The Interface', slug: 'guide/interface' },
                  { label: 'Settings & Preferences', slug: 'guide/settings' },
                  { label: 'Keyboard Shortcuts', slug: 'guide/shortcuts' },
                ],
              },
              {
                label: 'Working with the agent',
                items: [
                  { label: 'Chat', slug: 'using/chat' },
                  { label: 'Conversations', slug: 'using/conversations' },
                  { label: 'Workspaces', slug: 'using/workspaces' },
                  { label: 'File Context', slug: 'using/file-context' },
                  { label: 'Skills', slug: 'using/skills' },
                  { label: 'Multi-Agent Delegation', slug: 'using/delegation' },
                  { label: 'Automations', slug: 'using/automations' },
                ],
              },
              {
                label: 'Apps & connectors',
                items: [
                  { label: 'Installing Apps', slug: 'using/installing-apps' },
                  { label: 'Managing Apps', slug: 'using/managing-apps' },
                  { label: 'Connectors', slug: 'using/connectors' },
                  { label: 'Personal connectors', slug: 'using/personal-connectors' },
                ],
              },
              {
                label: 'Team',
                items: [
                  { label: 'User Management', slug: 'using/users' },
                  { label: 'Telemetry', slug: 'using/telemetry' },
                ],
              },
            ],
          },
          {
            label: 'Connect via MCP',
            link: '/connect/external-clients',
            icon: 'external',
            items: [
              { label: 'Connecting External Clients', slug: 'connect/external-clients' },
              { label: 'MCP Endpoint Reference', slug: 'connect/mcp-endpoint' },
            ],
          },
          {
            label: 'Building Apps',
            link: '/apps/overview',
            icon: 'puzzle',
            items: [
              { label: 'App Overview', slug: 'apps/overview' },
              { label: 'Manifest Reference', slug: 'apps/manifest' },
              { label: 'Host Capabilities', slug: 'apps/host-capabilities' },
              { label: 'Synapse SDK', slug: 'apps/synapse' },
              { label: 'Tool Results & Content Routing', slug: 'apps/tool-results' },
              { label: 'MCP App Bridge', slug: 'apps/bridge' },
              { label: 'UI Resources', slug: 'apps/ui-resources' },
              { label: 'Theming', slug: 'apps/theming' },
              { label: 'Placements & Navigation', slug: 'apps/placements' },
              { label: 'Custom Instructions', slug: 'apps/custom-instructions' },
              { label: 'Local Development', slug: 'apps/local-dev' },
              { label: 'Publishing to mpak', slug: 'apps/publishing' },
              { label: 'Example: Hello World App', slug: 'apps/hello-world' },
            ],
          },
          {
            label: 'CLI',
            link: '/cli/overview',
            icon: 'seti:shell',
            items: [
              { label: 'Overview', slug: 'cli/overview' },
              { label: 'Running the server', slug: 'cli/serve' },
              { label: 'Dev mode', slug: 'cli/dev' },
            ],
          },
          {
            label: 'Configuration',
            link: '/config/nimblebrain-json',
            icon: 'setting',
            items: [
              { label: 'nimblebrain.json', slug: 'config/nimblebrain-json' },
              { label: 'instance.json', slug: 'config/instance-json' },
              { label: 'workspace.json', slug: 'config/workspace-json' },
              { label: 'Bundle Configuration', slug: 'config/bundles' },
              { label: 'Credentials', slug: 'config/credentials' },
              { label: 'Connectors Catalog', slug: 'config/connectors-catalog' },
              { label: 'Agent Profiles', slug: 'config/agents' },
              { label: 'Logging', slug: 'config/logging' },
              { label: 'Feature Flags', slug: 'config/features' },
              { label: 'Environment Variables', slug: 'config/environment' },
            ],
          },
          {
            label: 'Deployment',
            link: '/deploy/docker',
            icon: 'cloud-download',
            items: [
              { label: 'Docker Compose', slug: 'deploy/docker' },
              { label: 'Security', slug: 'deploy/security' },
              { label: 'Observability', slug: 'deploy/observability' },
              { label: 'Composio Aggregator', slug: 'deploy/composio' },
            ],
          },
        ]),
      ],
    }),
  ],
});
