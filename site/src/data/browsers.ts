export const platforms = ['desktop', 'mobile'] as const;
type Platform = typeof platforms[number];
type Installation = {
  os?: string;
  pending?: string;
  action?: { label: string; href: string; requirements: string };
};
type Browser = {
  id: string;
  name: string;
  targets: Partial<Record<Platform, Installation>>;
};

// Install actions belong to a specific browser/platform pair: a desktop
// marketplace release must never accidentally enable its mobile action.
export const browsers: Browser[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    targets: {
      desktop: {
        action: {
          label: 'Chrome Web Store',
          href: 'https://chromewebstore.google.com/detail/anmerko/oligkkknbmklalfnkipmheifammnpgpo',
          requirements: 'Desktop Google Chrome 142 or later',
        },
      },
    },
  },
  {
    id: 'edge',
    name: 'Edge',
    targets: {
      desktop: {
        action: {
          label: 'Microsoft Edge Add-ons',
          href: 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka',
          requirements: 'Desktop Microsoft Edge',
        },
      },
      mobile: {
        os: 'Android',
        action: {
          label: 'Microsoft Edge Add-ons',
          href: 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka',
          requirements: 'Microsoft Edge for Android. Not available on iOS.',
        },
      },
    },
  },
  {
    id: 'firefox', name: 'Firefox',
    targets: {
      desktop: {
        action: {
          label: 'Firefox Add-ons',
          href: 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/',
          requirements: 'Desktop Firefox 142 or later',
        },
      },
      mobile: {
        os: 'Android',
        action: {
          label: 'Firefox Add-ons',
          href: 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/',
          requirements: 'Firefox for Android 142 or later. Not available on iOS.',
        },
      },
    },
  },
  {
    id: 'orion',
    name: 'Orion',
    targets: {
      mobile: {
        os: 'iPhone',
        action: {
          label: 'Install in Orion',
          href: '/docs/install/orion-iphone/',
          requirements: 'Orion on iPhone',
        },
      },
    },
  },
];
