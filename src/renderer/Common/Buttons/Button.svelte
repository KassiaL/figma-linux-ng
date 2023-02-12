<script lang="ts">
  export let round: number = 0;
  export let size: number | undefined = undefined;
  export let width = "inherit";
  export let height = "inherit";

  export let padding = "inherit";
  export let normalFgColor = "var(--fg-header)";
  export let normalBgColor = "var(--bg-header)";
  export let activeBgColor = "var(--bg-tab-hover)";
  export let hoverBgColor = "var(--bg-tab-hover)";

  export let isActive = false;

  if (size) {
    width = `${size}px`;
    height = `${size}px`;
  }
</script>

<div
  on:mousedown|capture
  on:mouseup|capture
  class={isActive ? "button__active" : ""}
  style={`
    --button-padding: ${padding};
    --button-width: ${width};
    --button-height: ${height};
    --button-border-radius: ${round}px;
    --button-normal-bg-color: ${normalBgColor};
    --button-hover-bg-color: ${hoverBgColor};
    --button-active-bg-color: ${activeBgColor};
    --button-normal-fg-color: ${normalFgColor};
  `}
>
  <slot />
</div>

<style>
  div {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--button-normal-bg-color);
    color: var(--button-normal-fg-color);
    border-radius: var(--button-border-radius);
    width: var(--button-width);
    height: var(--button-height);
    padding: var(--button-padding);
    transition: all 0.08s ease;
  }
  div:hover {
    background-color: var(--button-hover-bg-color);
  }
  .button__active {
    background-color: var(--button-active-bg-color);
  }
</style>
