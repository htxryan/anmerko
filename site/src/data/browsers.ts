export const platforms = ['desktop', 'mobile'] as const;
type Platform = typeof platforms[number];
type OperatingSystem = 'Android' | 'iPhone';
type InstallationAction = { label: string; href: string; requirements: string };
type Installation = {
  os?: OperatingSystem[];
  pending?: string;
  actions?: InstallationAction[];
};
type Browser = {
  id: string;
  name: string;
  targets: Partial<Record<Platform, Installation>>;
};

// Install actions belong to a specific browser/platform pair: a desktop
// marketplace release must never accidentally enable its mobile actions.
export const browsers: Browser[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    targets: {
      desktop: {
        actions: [{
          label: 'Chrome Web Store',
          href: 'https://chromewebstore.google.com/detail/anmerko/oligkkknbmklalfnkipmheifammnpgpo',
          requirements: 'Desktop Google Chrome 142 or later',
        }],
      },
    },
  },
  {
    id: 'edge',
    name: 'Edge',
    targets: {
      desktop: {
        actions: [{
          label: 'Microsoft Edge Add-ons',
          href: 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka',
          requirements: 'Desktop Microsoft Edge',
        }],
      },
      mobile: {
        os: ['Android', 'iPhone'],
        actions: [{
          label: 'Install on Android',
          href: 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka',
          requirements: 'Microsoft Edge for Android',
        }, {
          label: 'Install on iPhone',
          href: '/docs/install/edge-iphone/',
          requirements: 'Microsoft Edge for iPhone',
        }],
      },
    },
  },
  {
    id: 'firefox', name: 'Firefox',
    targets: {
      desktop: {
        actions: [{
          label: 'Firefox Add-ons',
          href: 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/',
          requirements: 'Desktop Firefox 142 or later',
        }],
      },
      mobile: {
        os: ['Android'],
        actions: [{
          label: 'Firefox Add-ons',
          href: 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/',
          requirements: 'Firefox for Android 142 or later. Not available on iOS.',
        }],
      },
    },
  },
  {
    id: 'orion',
    name: 'Orion',
    targets: {
      mobile: {
        os: ['iPhone'],
        actions: [{
          label: 'Install in Orion',
          href: '/docs/install/orion-iphone/',
          requirements: 'Orion on iPhone',
        }],
      },
    },
  },
];
