declare namespace Types {
  interface TabItem {
    id: string;
    text: string;
    disabled?: boolean;
    itemArgs?: Types.Dic<unknown>;
    item: import("svelte").ComponentType;
  }

  interface SetingsTabItem extends TabItem {
    bodyComponent: import("svelte").ComponentType;
    headerComponent?: import("svelte").ComponentType;
  }

  interface ThemeCreatorPopupMenuItem extends TabItem {
    handler: () => void;
  }
}
