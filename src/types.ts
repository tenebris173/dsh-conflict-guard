export interface PluginEntry {
  id: string
  name: string
  packageName: string
  packageDir: string
  disabled: boolean
  prefixes: string[]
  exact: string[]
  services: string[]
  slots: string[]
  dynamicRoutes: string[]
  deps: Record<string, string>
}

export interface RouteScan {
  packageName: string
  packageDir: string
  prefixes: string[]
  exact: string[]
  ids: string[]
  services: string[]
  slots: string[]
  dynamicRoutes: string[]
  deps: Record<string, string>
}

export interface Conflict {
  kind: 'route-prefix' | 'route-exact' | 'route-shadow' | 'plugin-id' | 'package-name' | 'service' | 'slot' | 'dependency'
  severity: 'error' | 'warning'
  candidate: string
  existing: string
  detail: string
  candidateId?: string
  existingId?: string
  route?: string
}
