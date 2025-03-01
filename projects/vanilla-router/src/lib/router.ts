import {
  NgModuleRef,
  ApplicationRef,
  Injector,
  Type,
  ComponentRef,
  createComponent,
  EnvironmentInjector,
} from '@angular/core';

export interface Route {
  path: string;
  loadComponent?: () => Promise<Type<any>>; // For Angular components
  loadChildren?: () => Promise<NgModuleRef<any>>; // For Angular modules
  redirectTo?: string;
  pathMatch?: 'full' | 'prefix';
  data?: Record<string, any>;
  children?: Route[]; // Support for nested routes
  canActivate?: CanActivate[]; // Route guards
  canDeactivate?: CanDeactivate[]; // Route deactivation guards
  canLoad?: CanLoad[]; // Lazy loading guards
  resolve?: Record<string, Resolve<any>>; // Resolvers
  errorComponent?: Type<any>; // Fallback component for errors
}

export interface RouterConfig {
  routes: Route[];
  rootElement?: HTMLElement | null;
  enableTracing?: boolean; // For debugging
}

export interface ActivatedRoute {
  params: Record<string, string>;
  queryParams: Record<string, string>;
  path: string;
  data?: Record<string, any>; // Data associated with the route
}

export interface CanActivate {
  canActivate(route: ActivatedRoute): boolean | Promise<boolean>;
}

export interface CanDeactivate {
  canDeactivate(route: ActivatedRoute): boolean | Promise<boolean>;
}

export interface CanLoad {
  canLoad(route: Route): boolean | Promise<boolean>;
}

export interface Resolve<T> {
  resolve(route: ActivatedRoute): T | Promise<T>;
}

export class Router {
  private routes: Route[] = [];
  private currentParams: Record<string, string> = {};
  private rootElement: HTMLElement | null;
  private enableTracing: boolean;
  private currentComponentRef: ComponentRef<any> | null = null;
  private currentModuleRef: NgModuleRef<any> | null = null;

  // Expose current path and query as public properties
  public currentPath: string = '';
  public currentQuery: Record<string, string> = {};

  constructor(
    config: RouterConfig,
    private appRef: ApplicationRef,
    private injector: Injector,
    private environmentInjector: EnvironmentInjector
  ) {
    this.routes = config.routes;

    // Ensure the wildcard route is the last route
    const wildcardIndex = this.routes.findIndex((r) => r.path === '*');
    if (wildcardIndex >= 0 && wildcardIndex !== this.routes.length - 1) {
      throw new Error('The wildcard route (path: "*") must be the last route in the configuration.');
    }

    this.rootElement = config.rootElement || document.getElementById('app');
    this.enableTracing = config.enableTracing || false;

    this._handlePopState = this._handlePopState.bind(this);
    this._handleClick = this._handleClick.bind(this);

    this._bindEvents();
    this._navigateToCurrentUrl();
  }

  // Navigate to a new path
  navigate(path: string, replace: boolean = false): void {
    if (this.enableTracing) {
      console.log(`Navigating to: ${path}`);
    }

    const method = replace ? 'replaceState' : 'pushState';
    window.history[method]({}, '', path);
    this._handleRouting(path);
  }

  // Start the router
  start(): void {
    this._navigateToCurrentUrl();
  }

  // Create a link element
  createLink(to: string, text: string, className: string = ''): HTMLAnchorElement {
    const link = document.createElement('a');
    link.href = to;
    link.textContent = text;
    if (className) link.className = className;

    link.addEventListener('click', (e) => {
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.navigate(to);
      }
    });

    return link;
  }

  private _handleRedirect(redirectTo: string, params: Record<string, string>): string {
    return redirectTo.replace(/:\w+/g, (match) => {
      const paramName = match.slice(1); // Remove the leading ':'
      return params[paramName] || match; // Replace with actual value or keep the placeholder
    });
  }

  // Handle routing logic
  private async _handleRouting(path: string): Promise<void> {
    const { pathname, params, query } = this._parsePath(path);
    this.currentParams = params;
    this.currentPath = pathname;
    this.currentQuery = query;

    const route = this._findMatchingRoute(this.routes, pathname);

    if (route) {
      // Check route guards
      if (route.canActivate) {
        const canActivateResults = await Promise.all(
          route.canActivate.map((guard) =>
            guard.canActivate({
              params: this.currentParams,
              queryParams: this.currentQuery,
              path: this.currentPath,
              data: route.data,
            })
          )
        );

        if (canActivateResults.some((result) => !result)) {
          // If any guard returns false, block navigation
          return;
        }
      }

      // Check lazy loading guards
      if (route.canLoad && (route.loadChildren || route.loadComponent)) {
        const canLoadResults = await Promise.all(
          route.canLoad.map((guard) => guard.canLoad(route))
        );

        if (canLoadResults.some((result) => !result)) {
          // If any guard returns false, block lazy loading
          return;
        }
      }

      // Check deactivation guards
      if (this.currentComponentRef && route.canDeactivate) {
        const canDeactivateResults = await Promise.all(
          route.canDeactivate.map((guard) =>
            guard.canDeactivate({
              params: this.currentParams,
              queryParams: this.currentQuery,
              path: this.currentPath,
              data: route.data,
            })
          )
        );

        if (canDeactivateResults.some((result) => !result)) {
          // If any guard returns false, block navigation
          return;
        }
      }

      // Resolve data
      const resolvedData: Record<string, any> = {};
      if (route.resolve) {
        await Promise.all(
          Object.entries(route.resolve).map(async ([key, resolver]) => {
            resolvedData[key] = await resolver.resolve({
              params: this.currentParams,
              queryParams: this.currentQuery,
              path: this.currentPath,
              data: route.data,
            });
          })
        );
      }

      // Prepare the ActivatedRoute object with the route data
      const activatedRoute: ActivatedRoute = {
        params: this.currentParams,
        queryParams: this.currentQuery,
        path: this.currentPath,
        data: { ...route.data, ...resolvedData }, // Merge route data with resolved data
      };

      if (route.redirectTo) {
        const redirectPath = this._handleRedirect(route.redirectTo, params);
        this.navigate(redirectPath, true);
        return;
      }

      try {
        // Handle Angular module loading
        if (route.loadChildren) {
          const module = await route.loadChildren();
          this.currentModuleRef = module;

          // Bootstrap the Angular module
          const component = module.instance.ngDoBootstrap();
          if (component) {
            this._renderAngularComponent(component, activatedRoute);
          }
        }
        // Handle Angular component loading
        else if (route.loadComponent) {
          const component = await route.loadComponent();
          this._renderAngularComponent(component, activatedRoute);
        }
      } catch (error) {
        console.error('Failed to load component/module:', error);
        if (route.errorComponent) {
          this._renderAngularComponent(route.errorComponent, activatedRoute);
        } else {
          if (this.rootElement) {
            this.rootElement.innerHTML = '<h1>Failed to load component/module</h1>';
          }
        }
      }
    } else {
      if (this.rootElement) {
        this.rootElement.innerHTML = '<h1>404 - Page Not Found</h1>';
      }
    }

    window.dispatchEvent(
      new CustomEvent('routechange', {
        detail: { path, params, query },
      })
    );
  }

  // Render an Angular component
  private _renderAngularComponent(component: Type<any>, activatedRoute: ActivatedRoute): void {
    // Clean up the previous component and module
    if (this.currentComponentRef) {
      this.currentComponentRef.destroy();
    }
    if (this.currentModuleRef) {
      this.currentModuleRef.destroy(); // Destroy the module reference
      this.currentModuleRef = null;
    }

    // Create the component dynamically
    this.currentComponentRef = createComponent(component, {
      environmentInjector: this.environmentInjector,
    });

    // Pass ActivatedRoute data as input properties
    if (this.currentComponentRef.instance.routeData) {
      this.currentComponentRef.instance.routeData = activatedRoute;
    }

    if (this.rootElement) {
      this.rootElement.innerHTML = ''; // Clear the root element
      this.rootElement.appendChild(this.currentComponentRef.location.nativeElement);
    }
  }

  // Find the matching route
  private _findMatchingRoute(routes: Route[], path: string): Route | null {
    let bestMatch: Route | null = null;
    let bestMatchLength = -1;

    for (const route of routes) {
        const regex = this._convertPathToRegex(route.path);
        const match = path.match(regex);

        if (match) {
            const matchedLength = match[0].length;

            if (matchedLength > bestMatchLength) {
                bestMatch = route;
                bestMatchLength = matchedLength;
            }
        }
    }

    return bestMatch ?? routes.find(r => r.path === '*') ?? null;
}

private _convertPathToRegex(path: string): RegExp {
    const regexPath = path
        .replace(/\/:([^/]+)/g, '/([^/]+)')
        .replace(/\*/g, '.*');

    return new RegExp(`^${regexPath}$`);
  }

  // Parse the path and query parameters
  private _parsePath(path: string): {
    pathname: string;
    params: Record<string, string>;
    query: Record<string, string>;
  } {
    const [pathname, queryString] = path.split('?');
    const query: Record<string, string> = {};
    const params: Record<string, string> = {};

    // Process query parameters
    if (queryString) {
      queryString.split('&').forEach((param) => {
        const [key, value] = param.split('=');
        if (key) {
          query[key] = value ? decodeURIComponent(value) : '';
        }
      });
    }

    // Find matching route and extract parameters
    const route = this._findMatchingRoute(this.routes, pathname);
    if (route) {
      this._extractRouteParams(route, pathname, params);
    }

    return { pathname, params, query };
  }

  private _extractRouteParams(route: Route, pathname: string, params: Record<string, string>): void {
    const routeSegments = route.path.split('/').filter(Boolean);
    const pathSegments = pathname.split('/').filter(Boolean);

    for (let i = 0; i < routeSegments.length && i < pathSegments.length; i++) {
      const routeSegment = routeSegments[i];
      const pathSegment = pathSegments[i];

      if (routeSegment.startsWith(':')) {
        const paramName = routeSegment.slice(1);
        params[paramName] = pathSegment;
      }
    }

    // Recursively extract parameters from child routes
    if (route.children) {
      const remainingPath = pathSegments.slice(routeSegments.length).join('/');
      const childRoute = this._findMatchingRoute(route.children, remainingPath);
      if (childRoute) {
        this._extractRouteParams(childRoute, remainingPath, params);
      }
    }
  }

  // Navigate to the current URL
  private _navigateToCurrentUrl(): void {
    const currentPath = window.location.pathname + window.location.search;
    this._handleRouting(currentPath);
  }

  // Bind event listeners
  private _bindEvents(): void {
    window.addEventListener('popstate', this._handlePopState);
    document.addEventListener('click', this._handleClick);
  }

  // Handle popstate events
  private _handlePopState(): void {
    const currentPath = window.location.pathname + window.location.search;
    this._handleRouting(currentPath);
  }

  // Handle link clicks
  private _handleClick(e: MouseEvent): void {
    const link = (e.target as HTMLElement).closest('a');
    if (!link) return;

    if (
      link.target === '_blank' ||
      link.hasAttribute('download') ||
      link.href.startsWith('mailto:') ||
      link.href.startsWith('tel:') ||
      link.href.indexOf('://') !== -1 ||
      e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0
    ) {
      return;
    }

    const href = link.getAttribute('href');
    if (href && href.startsWith('/')) {
      e.preventDefault();
      this.navigate(href);
    }
  }
}
