// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import starlightLinksValidator from 'starlight-links-validator';
import { starlightThemeCss } from './src/theme/starlight.ts';

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
    '/config/bundles': '/config/connectors/',
    '/deploy/composio': '/gateways/composio/',
    '/guide/chat': '/using/chat/',
    '/guide/conversations': '/using/conversations/',
    '/guide/apps': '/using/connectors/',
    '/guide/files': '/using/file-context/',
    '/guide/workspaces': '/using/workspaces/',
    '/guide/team': '/using/users/',
    '/guide/mcp-connect': '/connect/external-clients/',
    '/cli/user': '/cli/overview/',
    '/cli/interactive': '/using/chat/',
    '/cli/bundle': '/using/connectors/',
    '/cli/skill': '/using/skills/',
    '/cli/config': '/config/credentials/',
    '/cli/credential': '/config/credentials/',
    '/cli/status': '/cli/overview/',
    '/cli/reload': '/cli/overview/',
    '/cli/telemetry': '/using/telemetry/',
    '/cli/automation': '/using/tasks/',
    // Automations are tasks; the page moved with the rename.
    '/using/automations': '/using/tasks/',
    // Extension pages moved into their own section.
    '/apps/facets': '/extensions/facets/',
    '/apps/lifecycle': '/extensions/lifecycle/',
    '/apps/notifications': '/extensions/notifications/',
    '/apps/placements': '/extensions/placements/',
    '/apps/custom-instructions': '/extensions/custom-instructions/',
    '/mcp/host-resources': '/extensions/host-resources/',
    '/mcp/reserved-keys': '/extensions/reserved-keys/',
  },
  integrations: [
    starlight({
      title: 'NimbleBrain',
      favicon: '/favicon.ico',
      logo: {
        light: './src/assets/nb-logo-full-light.svg',
        dark: './src/assets/nb-logo-full-dark.svg',
        alt: 'NimbleBrain',
        replacesTitle: true,
      },
      customCss: ['@fontsource-variable/jetbrains-mono', './src/styles/custom.css'],
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
            href: 'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap',
          },
        },
        // Colours and font stacks, projected from the runtime palette at build time.
        { tag: 'style', content: starlightThemeCss() },
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
                  { label: 'Files', slug: 'using/files' },
                  { label: 'File Context', slug: 'using/file-context' },
                  { label: 'Skills', slug: 'using/skills' },
                  { label: 'Tasks', slug: 'using/tasks' },
                  {
                    label: 'Notifications',
                    items: [
                      { label: 'Overview', slug: 'using/notifications' },
                      { label: 'Delivering to a channel', slug: 'using/notification-channels' },
                      {
                        label: "When one doesn't arrive",
                        slug: 'using/notification-troubleshooting',
                      },
                      { label: 'Route reference', slug: 'using/notification-reference' },
                    ],
                  },
                ],
              },
              {
                label: 'Apps & connectors',
                items: [
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
            label: 'MCP',
            link: '/mcp/overview',
            icon: 'seti:json',
            items: [
              { label: 'NimbleBrain and MCP', slug: 'mcp/overview' },
              { label: 'Protocol Support', slug: 'mcp/protocol-support' },
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
              { label: 'Synapse SDK', slug: 'apps/synapse' },
              { label: 'Tool Results & Content Routing', slug: 'apps/tool-results' },
              { label: 'MCP App Bridge', slug: 'apps/bridge' },
              { label: 'UI Resources', slug: 'apps/ui-resources' },
              { label: 'Theming', slug: 'apps/theming' },
              { label: 'Local Development', slug: 'apps/local-dev' },
              { label: 'Example: Hello World App', slug: 'apps/hello-world' },
            ],
          },
          {
            label: 'Extensions',
            link: '/extensions/overview',
            icon: 'server',
            items: [
              { label: 'Overview', slug: 'extensions/overview' },
              { label: 'Lifecycle', slug: 'extensions/lifecycle' },
              { label: 'Facets', slug: 'extensions/facets' },
              { label: 'Notifications', slug: 'extensions/notifications' },
              { label: 'Inbound Webhooks', slug: 'extensions/webhooks' },
              { label: 'Settings Sections', slug: 'extensions/settings-sections' },
              { label: 'Admin-only Tools', slug: 'extensions/admin-tools' },
              { label: 'Placements & Navigation', slug: 'extensions/placements' },
              { label: 'Host Resources', slug: 'extensions/host-resources' },
              { label: 'Custom Instructions', slug: 'extensions/custom-instructions' },
              {
                label: 'App Bridge Extensions',
                link: '/apps/bridge/#nimblebrain-extensions-ainimblebrain',
              },
              { label: 'Reserved Keys', slug: 'extensions/reserved-keys' },
            ],
          },
          {
            label: 'CLI',
            link: '/cli/overview',
            icon: 'seti:shell',
            items: [
              { label: 'Overview', slug: 'cli/overview' },
              { label: 'Running the server', slug: 'cli/serve' },
              { label: 'Managing secrets', slug: 'cli/secrets' },
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
              { label: 'Connector Configuration', slug: 'config/connectors' },
              { label: 'Credentials', slug: 'config/credentials' },
              { label: 'Secrets', slug: 'config/secrets' },
              { label: 'Connector Providers', slug: 'config/connector-providers' },
              { label: 'Connectors Catalog', slug: 'config/connectors-catalog' },
              { label: 'Logging', slug: 'config/logging' },
              { label: 'Feature Flags', slug: 'config/features' },
              { label: 'Environment Variables', slug: 'config/environment' },
            ],
          },
          {
            label: 'MCP Gateways',
            link: '/config/connector-providers',
            icon: 'puzzle',
            items: [
              { label: 'Composio', slug: 'gateways/composio' },
              { label: 'Smithery', slug: 'gateways/smithery' },
              { label: 'MCP360', slug: 'gateways/mcp360' },
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
            ],
          },
        ]),
      ],
    }),
  ],
});
