declare module "svg-maps__common" {
  export interface Location {
    id: string;
    name: string;
    path: string;
  }

  export interface Map {
    label: string;
    viewBox: string;
    locations: Location[];
  }
}
