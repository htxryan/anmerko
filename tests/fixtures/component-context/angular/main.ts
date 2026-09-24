import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  ApplicationRef,
  Component,
  ComponentRef,
  ElementRef,
  Input,
  VERSION,
  ViewChild,
  ViewContainerRef,
  ViewEncapsulation,
  enableProdMode,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { createApplication } from '@angular/platform-browser';

declare const BRIEFMARK_ANGULAR_BUILD_MODE: 'development' | 'production';
declare const BRIEFMARK_ANGULAR_OPTIMIZED: boolean;

type FixtureRoot = 'primary' | 'secondary';
type SentinelName = 'props' | 'source' | 'state';

interface AngularFixtureManifest {
  readonly contractVersion: 1;
  readonly framework: 'angular';
  readonly runtime: {
    readonly angularVersion: string;
    readonly buildMode: 'development' | 'production';
    readonly aot: true;
    readonly optimized: boolean;
    readonly devToolsInstalled: false;
  };
  readonly entries: {
    readonly development: 'development/browser/main.js';
    readonly production: 'production/browser/main.js';
  };
  readonly roots: readonly ['angular-app-host', 'angular-secondary-app-host'];
  readonly selectedTargets: {
    readonly host: {
      readonly id: 'angular-plan-card-host';
      readonly expectedNames: readonly ['AppComponent', 'PricingPageComponent', 'PlanCardComponent'];
      readonly expectedDescriptorNames: readonly [
        '_AppComponent',
        '_PricingPageComponent',
        '_PlanCardComponent',
      ];
    };
    readonly leaf: {
      readonly id: 'angular-plan-card-leaf';
      readonly expectedNames: readonly ['AppComponent', 'PricingPageComponent', 'PlanCardComponent'];
      readonly expectedDescriptorNames: readonly [
        '_AppComponent',
        '_PricingPageComponent',
        '_PlanCardComponent',
      ];
    };
  };
  readonly controls: {
    readonly embedded: 'angular-toggle-embedded';
    readonly projectedEmbedded: 'angular-toggle-projected-embedded';
    readonly dynamicDisposal: 'angular-dispose-dynamic';
  };
  readonly sentinels: {
    readonly values: {
      readonly props: 'fixture-props-must-not-be-read';
      readonly state: 'fixture-state-must-not-be-read';
      readonly source: 'fixture-source-must-not-be-read';
    };
    readonly reads: Record<SentinelName, number>;
  };
  ready: boolean;
  error?: string;
}

declare global {
  interface Window {
    __BRIEFMARK_ANGULAR_FIXTURE__: AngularFixtureManifest;
    __BRIEFMARK_MIXED_TARGETS_READY__?: Promise<readonly string[]>;
  }
}

const sentinelReads: Record<SentinelName, number> = {
  props: 0,
  source: 0,
  state: 0,
};

const fixtureManifest: AngularFixtureManifest = {
  contractVersion: 1,
  framework: 'angular',
  runtime: {
    angularVersion: VERSION.full,
    buildMode: BRIEFMARK_ANGULAR_BUILD_MODE,
    aot: true,
    optimized: BRIEFMARK_ANGULAR_OPTIMIZED,
    devToolsInstalled: false,
  },
  entries: {
    development: 'development/browser/main.js',
    production: 'production/browser/main.js',
  },
  roots: ['angular-app-host', 'angular-secondary-app-host'],
  selectedTargets: {
    host: {
      id: 'angular-plan-card-host',
      expectedNames: ['AppComponent', 'PricingPageComponent', 'PlanCardComponent'],
      expectedDescriptorNames: ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'],
    },
    leaf: {
      id: 'angular-plan-card-leaf',
      expectedNames: ['AppComponent', 'PricingPageComponent', 'PlanCardComponent'],
      expectedDescriptorNames: ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'],
    },
  },
  controls: {
    embedded: 'angular-toggle-embedded',
    projectedEmbedded: 'angular-toggle-projected-embedded',
    dynamicDisposal: 'angular-dispose-dynamic',
  },
  sentinels: {
    values: {
      props: 'fixture-props-must-not-be-read',
      state: 'fixture-state-must-not-be-read',
      source: 'fixture-source-must-not-be-read',
    },
    reads: sentinelReads,
  },
  ready: false,
};

Object.defineProperty(window, '__BRIEFMARK_ANGULAR_FIXTURE__', {
  configurable: false,
  enumerable: true,
  value: fixtureManifest,
  writable: false,
});

function fixtureId(root: FixtureRoot, primaryId: string): string {
  return root === 'primary' ? primaryId : `angular-secondary-${primaryId.slice('angular-'.length)}`;
}

function tripSentinel(name: SentinelName): never {
  sentinelReads[name] += 1;
  throw new Error(`Component-context fixture read forbidden ${name} data`);
}

@Component({
  selector: 'plan-card',
  standalone: true,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <article [attr.data-fixture-id]="leafId">
      <h2>Professional</h2>
      <button [attr.data-fixture-id]="buttonId" type="button">Choose plan</button>
      <div [attr.data-fixture-id]="projectionSlotId"><ng-content /></div>
    </article>
  `,
  styles: `
    :host { display: block; border: 1px solid currentColor; padding: 0.75rem; }
    article { display: grid; gap: 0.5rem; }
  `,
})
export class PlanCardComponent {
  @Input({ required: true }) fixtureRoot!: FixtureRoot;
  @Input() dynamic = false;

  readonly customerSecret = 'fixture-sensitive-value-must-not-be-collected';

  get props(): never {
    return tripSentinel('props');
  }

  get state(): never {
    return tripSentinel('state');
  }

  get source(): never {
    return tripSentinel('source');
  }

  get leafId(): string {
    return fixtureId(
      this.fixtureRoot,
      this.dynamic ? 'angular-dynamic-card-surface' : 'angular-plan-card-surface',
    );
  }

  get buttonId(): string {
    return fixtureId(
      this.fixtureRoot,
      this.dynamic ? 'angular-dynamic-leaf' : 'angular-plan-card-leaf',
    );
  }

  get projectionSlotId(): string {
    return fixtureId(this.fixtureRoot, 'angular-projection-slot');
  }
}

@Component({
  selector: 'pricing-page',
  standalone: true,
  imports: [PlanCardComponent],
  template: `
    <section [attr.data-fixture-id]="id('angular-pricing-page-inner')">
      <plan-card
        [attr.data-fixture-id]="id('angular-plan-card-host')"
        [fixtureRoot]="fixtureRoot"
      >
        <ng-content />
      </plan-card>

      <button
        [attr.data-fixture-id]="id('angular-toggle-embedded')"
        type="button"
        (click)="showEmbedded.set(!showEmbedded())"
      >Toggle embedded view</button>
      @if (showEmbedded()) {
        <aside [attr.data-fixture-id]="id('angular-embedded-view')">
          @for (feature of features; track feature) {
            <span [attr.data-fixture-id]="id('angular-embedded-' + feature)">{{ feature }}</span>
          }
        </aside>
      }

      <ng-template #dynamicOutlet />
      <button
        [attr.data-fixture-id]="id('angular-dispose-dynamic')"
        type="button"
        (click)="disposeDynamicCard()"
      >Dispose dynamic view</button>

      <div
        #unmanagedContainer
        [attr.data-fixture-id]="id('angular-unmanaged-container')"
      ></div>
    </section>
  `,
})
export class PricingPageComponent implements AfterViewInit {
  @Input({ required: true }) fixtureRoot!: FixtureRoot;
  @ViewChild('dynamicOutlet', { read: ViewContainerRef, static: true })
  private dynamicOutlet!: ViewContainerRef;
  @ViewChild('unmanagedContainer', { read: ElementRef, static: true })
  private unmanagedContainer!: ElementRef<HTMLElement>;

  readonly features = ['reports', 'exports'];
  readonly showEmbedded = signal(true);
  private dynamicCard?: ComponentRef<PlanCardComponent>;

  ngAfterViewInit(): void {
    this.dynamicCard = this.dynamicOutlet.createComponent(PlanCardComponent);
    this.dynamicCard.setInput('fixtureRoot', this.fixtureRoot);
    this.dynamicCard.setInput('dynamic', true);
    this.dynamicCard.location.nativeElement.setAttribute(
      'data-fixture-id',
      this.id('angular-dynamic-host'),
    );

    this.unmanagedContainer.nativeElement.innerHTML = `<button type="button" data-fixture-id="${this.id(
      'angular-unmanaged-innerhtml',
    )}" data-secret="fixture-innerhtml-secret">Unmanaged</button>`;
    const unmanaged = this.unmanagedContainer.nativeElement.querySelector(
      '[data-fixture-id="angular-unmanaged-innerhtml"]',
    );
    if (unmanaged) {
      const clone = unmanaged.cloneNode(true) as HTMLElement;
      clone.dataset['fixtureId'] = this.id('angular-unmanaged-clone');
      this.unmanagedContainer.nativeElement.append(clone);
    }
  }

  disposeDynamicCard(): void {
    this.dynamicCard?.destroy();
    this.dynamicCard = undefined;
  }

  id(primaryId: string): string {
    return fixtureId(this.fixtureRoot, primaryId);
  }
}

@Component({
  selector: 'angular-fixture-app',
  standalone: true,
  imports: [PricingPageComponent],
  template: `
    <main [attr.data-fixture-id]="id('angular-app-inner')">
      <h1>Angular component context fixture</h1>
      <button
        [attr.data-fixture-id]="id('angular-toggle-projected-embedded')"
        type="button"
        (click)="showProjectedEmbedded.set(!showProjectedEmbedded())"
      >Toggle projected embedded view</button>
      <pricing-page
        [attr.data-fixture-id]="id('angular-pricing-host')"
        [fixtureRoot]="fixtureRoot"
      >
        <article [attr.data-fixture-id]="id('angular-projected-host')">
          <span [attr.data-fixture-id]="id('angular-projected-leaf')">Projected content</span>
          @if (showProjectedEmbedded()) {
            <em [attr.data-fixture-id]="id('angular-projected-embedded')">
              Projected embedded content
            </em>
          }
        </article>
      </pricing-page>
    </main>
  `,
})
export class AppComponent {
  readonly fixtureRoot: FixtureRoot;
  readonly showProjectedEmbedded = signal(true);

  constructor(host: ElementRef<HTMLElement>) {
    this.fixtureRoot =
      host.nativeElement.dataset['angularFixtureRoot'] === 'secondary' ? 'secondary' : 'primary';
  }

  id(primaryId: string): string {
    return fixtureId(this.fixtureRoot, primaryId);
  }
}

@Component({
  selector: '[data-angular-overlap]',
  standalone: true,
  template: '',
})
export class MixedOverlapComponent {}

function createRootHost(document: Document, root: FixtureRoot): HTMLElement {
  const host = document.createElement('angular-fixture-app');
  host.dataset['angularFixtureRoot'] = root;
  host.dataset['fixtureId'] =
    root === 'primary' ? 'angular-app-host' : 'angular-secondary-app-host';
  document.body.append(host);
  return host;
}

async function startFixture(): Promise<void> {
  if (BRIEFMARK_ANGULAR_BUILD_MODE === 'production') {
    enableProdMode();
  }

  const application: ApplicationRef = await createApplication({
    providers: [provideZonelessChangeDetection()],
  });
  const document = application.injector.get(DOCUMENT);

  application.bootstrap(AppComponent, createRootHost(document, 'primary'));
  application.bootstrap(AppComponent, createRootHost(document, 'secondary'));

  await application.whenStable();
  const mixedTargetIds = window.__BRIEFMARK_MIXED_TARGETS_READY__
    ? await window.__BRIEFMARK_MIXED_TARGETS_READY__ : [];
  const uniqueTargetIds = new Set(mixedTargetIds);
  if (uniqueTargetIds.size !== mixedTargetIds.length) {
    throw new Error('Mixed Angular overlap target IDs must be unique');
  }
  for (const targetId of mixedTargetIds) {
    const target = document.getElementById(targetId);
    if (!(target instanceof HTMLElement) || !target.hasAttribute('data-angular-overlap')) {
      throw new Error(`Missing mixed Angular overlap target: ${targetId}`);
    }
    application.bootstrap(MixedOverlapComponent, target);
  }
  await application.whenStable();
  fixtureManifest.ready = true;
}

void startFixture().catch((error: unknown) => {
  fixtureManifest.error = error instanceof Error ? error.message : String(error);
  throw error;
});
