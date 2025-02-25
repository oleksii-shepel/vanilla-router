export interface Route {
  path: string;
  loadComponent?: () => Promise<any>;
  loadChildren?: () => Promise<any>;
  redirectTo?: string;
  pathMatch?: 'full' | 'prefix';
  data?: Record<string, any>;
  children?: Route[]; // Support for nested routes
  canActivate?: CanActivate[]; // Route guards
  resolve?: Record<string, Resolve<any>>; // Resolvers
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

export interface Resolve<T> {
  resolve(route: ActivatedRoute): T | Promise<T>;
}

export class Router {
  private routes: Route[] = [];
  private currentParams: Record<string, string> = {};
  private rootElement: HTMLElement | null;
  private enableTracing: boolean;

  // Expose current path and query as public properties
  public currentPath: string = '';
  public currentQuery: Record<string, string> = {};

  constructor(config: RouterConfig) {
    this.routes = config.routes;
    this.rootElement = config.rootElement || document.getElementById('app');
    this.enableTracing = config.enableTracing || false;

    this._handlePopState = this._handlePopState.bind(this);
    this._handleClick = this._handleClick.bind(this);

    this._bindEvents();
    this._navigateToCurrentUrl();
  }

  navigate(path: string, replace: boolean = false): void {
    if (this.enableTracing) {
      console.log(`Navigating to: ${path}`);
    }

    const method = replace ? 'replaceState' : 'pushState';
    window.history[method]({}, '', path);
    this._handleRouting(path);
  }

  start(): void {
    this._navigateToCurrentUrl();
  }

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
          route.canActivate.map(guard => guard.canActivate({
            params: this.currentParams,
            queryParams: this.currentQuery,
            path: this.currentPath,
            data: route.data,
          }))
        );

        if (canActivateResults.some(result => !result)) {
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
        this.navigate(route.redirectTo, true);
        return;
      }

      // Handle module loading
      if (route.loadChildren) {
        try {
          const module = await route.loadChildren();
          const component = module.default || module;
          if (this.rootElement) {
            this.rootElement.innerHTML = '';
            this.rootElement.appendChild(component(activatedRoute));
          }
        } catch (error) {
          if (this.rootElement) {
            this.rootElement.innerHTML = '<h1>Module failed to load</h1>';
          }
        }
      }
      // Handle component loading
      else if (route.loadComponent) {
        try {
          const component = await route.loadComponent();
          if (this.rootElement) {
            this.rootElement.innerHTML = '';
            this.rootElement.appendChild(component(activatedRoute));
          }
        } catch (error) {
          if (this.rootElement) {
            this.rootElement.innerHTML = '<h1>Component failed to load</h1>';
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

  private _findMatchingRoute(routes: Route[], pathname: string): Route | null {
    for (const route of routes) {
      if (route.path === pathname) {
        return route;
      }

      if (route.path === '*') {
        return route;
      }

      const routeSegments = route.path.split('/').filter(Boolean);
      const pathSegments = pathname.split('/').filter(Boolean);

      if (routeSegments.length !== pathSegments.length) {
        continue;
      }

      let isMatch = true;
      const params: Record<string, string> = {};

      for (let i = 0; i < routeSegments.length; i++) {
        const routeSegment = routeSegments[i];
        const pathSegment = pathSegments[i];

        if (routeSegment.startsWith(':')) {
          const paramName = routeSegment.slice(1);
          params[paramName] = pathSegment;
        } else if (routeSegment !== pathSegment) {
          isMatch = false;
          break;
        }
      }

      if (isMatch) {
        this.currentParams = params;
        if (route.children) {
          const childRoute = this._findMatchingRoute(route.children, pathname);
          if (childRoute) {
            return childRoute;
          }
        }
        return route;
      }
    }

    return null;
  }

  private _parsePath(path: string): {
    pathname: string;
    params: Record<string, string>;
    query: Record<string, string>;
  } {
    const [pathname, queryString] = path.split('?');
    const query: Record<string, string> = {};

    if (queryString) {
      queryString.split('&').forEach((param) => {
        const [key, value] = param.split('=');
        if (key) {
          query[key] = value ? decodeURIComponent(value) : '';
        }
      });
    }

    return { pathname, params: this.currentParams, query };
  }

  private _navigateToCurrentUrl(): void {
    const currentPath = window.location.pathname + window.location.search;
    this._handleRouting(currentPath);
  }

  private _bindEvents(): void {
    window.addEventListener('popstate', this._handlePopState);
    document.addEventListener('click', this._handleClick);
  }

  private _handlePopState(): void {
    const currentPath = window.location.pathname + window.location.search;
    this._handleRouting(currentPath);
  }

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

/*
// Example Guard
class AuthGuard implements CanActivate {
  canActivate(route: ActivatedRoute): boolean | Promise<boolean> {
    // Check if user is authenticated
    const isAuthenticated = localStorage.getItem('isAuthenticated') === 'true';
    return isAuthenticated;
  }
}

// Example Resolver
class UserResolver implements Resolve<{ name: string }> {
  resolve(route: ActivatedRoute): { name: string } | Promise<{ name: string }> {
    // Fetch user data from an API or service
    return Promise.resolve({ name: 'John Doe' });
  }
}

// Routes Configuration
const routes: Route[] = [
  {
    path: '/',
    loadComponent: () => import('./home-component'),
  },
  {
    path: '/about',
    loadComponent: () => import('./about-component'),
    canActivate: [new AuthGuard()], // Use the guard
    resolve: { user: new UserResolver() }, // Use the resolver
    children: [
      {
        path: 'team',
        loadComponent: () => import('./team-component'),
      },
    ],
  },
  {
    path: '/users/:id',
    loadChildren: () => import('./user-module'),
  },
  {
    path: '*',
    loadComponent: () => import('./not-found-component'),
  },
];

// Initialize Router
const router = new Router({
  routes,
  rootElement: document.getElementById('app'),
  enableTracing: true,
});

router.start();
*/
