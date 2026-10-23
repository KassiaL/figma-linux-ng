<script lang="ts">
  import { randomUUID } from "crypto";
  import { ipcRenderer } from "electron";
  import { InputRange, CheckBox, InputText, ListBox } from "Common/Input";
  import { Text, Label, Flex, FlexItem, Line } from "Common";
  import { ButtonTool, SecondaryButton } from "Common/Buttons";
  import { TOPPANELHEIGHT } from "Const";
  import { Folder } from "Common/Icons";
  import { settings, modalBounds } from "../../../store";

  import DirectoryListItem from "./DirectoryListItem.svelte";
  import SwitchListItem from "./SwitchListItem.svelte";

  export let zIndex: number;

  let items: Types.TabItem[] = [];
  $: items = $settings.app.fontDirs.map((dir) => ({
    id: dir,
    text: dir,
    item: DirectoryListItem,
  }));

  let switchItems: Types.TabItem[] = [];
  $: switchItems = $settings.app.commandSwitches.map((item) => ({
    id: randomUUID(),
    text: item.switch,
    itemArgs: {
      item,
    },
    item: SwitchListItem,
  }));

  async function onChangeExportPath(event: CustomEvent) {
    const directory = await ipcRenderer.invoke("selectExportDirectory");

    if (!directory) {
      return;
    }

    $settings.app.exportDir = directory;
  }
  function onItemRemoveClick(item: Types.TabItem) {
    $settings.app.fontDirs = items.filter((dir) => dir.id !== item.id).map((item) => item.id);
  }
  function onSwitchItemRemoveClick(item: Types.TabItem) {
    $settings.app.commandSwitches = switchItems.reduce<Types.CommandSwitch[]>((result, swtch) => {
      if (swtch.id !== item.id) {
        const sw = swtch.itemArgs.item as Types.CommandSwitch;
        result.push({
          switch: sw.switch,
          value: sw.value,
        });
      }

      return result;
    }, []);
  }
  async function onAddDirectory(event: CustomEvent) {
    const directory = await ipcRenderer.invoke("selectExportDirectory");

    if (!directory) {
      return;
    }

    $settings.app.fontDirs.push(directory);
    $settings.app.fontDirs = $settings.app.fontDirs;
  }
  async function onAddSwicth(event: CustomEvent) {
    $settings.app.commandSwitches.push({
      switch: "",
    });
    $settings.app.commandSwitches = $settings.app.commandSwitches;
  }
  function onClearList(event: CustomEvent) {
    $settings.app.fontDirs = [];
  }
  function onClearSwicthList(event: CustomEvent) {
    $settings.app.commandSwitches = [];
  }

  let bodyHeight: number;
  $: {
    if ($modalBounds) {
      bodyHeight = $modalBounds.height - 94;
    }
  }

  const gpuProfiles: Array<{ id: Types.GpuProfile; text: string }> = [
    { id: "vulkan", text: "Vulkan + WebGPU (recommended)" },
    { id: "vulkan-swapchain", text: "Vulkan + WebGPU, swapchain present (higher CPU on NVIDIA/X11)" },
    { id: "angle-vulkan", text: "ANGLE on Vulkan (GPU process sandbox off)" },
    { id: "chromium-default", text: "Chromium default: OpenGL, no WebGPU on X11" },
    { id: "software", text: "Software rendering (troubleshooting)" },
  ];
  // userAgentOS is "windows" | "linux"; shown as a switch.
  function onUserAgentChange(event: Event) {
    $settings.app.userAgentOS = (event.target as HTMLInputElement).checked ? "windows" : "linux";
  }

  $: {
    ipcRenderer.invoke("updateFigmaUiScale", $settings.ui.scaleFigmaUI);
  }
  $: {
    ipcRenderer.invoke("updatePanelScale", $settings.ui.scalePanel);
    $settings.app.panelHeight = Math.floor(TOPPANELHEIGHT * $settings.ui.scalePanel);
  }
</script>

<div style={`z-index: ${zIndex}; height: ${bodyHeight}px;`}>
  <Flex>
    <Flex der="column" width="-webkit-fill-available">
      <Label>Scale UI</Label>
      <InputRange bind:value={$settings.ui.scaleFigmaUI} min={0.5} max={1.5} step={0.05} />
      <Flex der="column" alignItems="center" justifyContent="center">
        <Text padding="8px 0 0 0">{Math.floor($settings.ui.scaleFigmaUI * 100)}%</Text>
      </Flex>
    </Flex>
    <Flex width="120px" />
    <Flex der="column" width="-webkit-fill-available">
      <Label>Scale Tabs</Label>
      <InputRange bind:value={$settings.ui.scalePanel} min={0.5} max={1.5} step={0.05} />
      <Flex der="column" alignItems="center" justifyContent="center">
        <Text padding="8px 0 0 0">{Math.floor($settings.ui.scalePanel * 100)}%</Text>
      </Flex>
    </Flex>
  </Flex>

  <Flex height="50px" />
  <Line />
  <Flex height="40px" />

  <Flex>
    <Flex der="column" width="-webkit-fill-available">
      <Label>Main settings</Label>
      <CheckBox bind:checked={$settings.app.saveLastOpenedTabs} text="Save the last opened tabs" />
      <CheckBox bind:checked={$settings.app.enableColorSpaceSrgb} text="Enable color space sRGB" />
      <CheckBox bind:checked={$settings.app.visibleNewProjectBtn} text="Show new project button" />
      <CheckBox bind:checked={$settings.app.useZenity} text="Use Zenity for Dialogs" />
      <CheckBox
        bind:checked={$settings.app.useOldPreviewer}
        text="Use old Previewer in ThemeCreator"
      />
      <CheckBox bind:checked={$settings.app.disableThemes} text="Disable themes" />
    </Flex>
    <Flex width="120px" />
    <Flex der="column" width="-webkit-fill-available">
      <Label>Export files to</Label>
      <Flex>
        <FlexItem grow={1}>
          <InputText bind:value={$settings.app.exportDir}>
            <ButtonTool normalBgColor="tarsparent" on:buttonClick={onChangeExportPath}>
              <Folder color="var(--text)" size="18" />
            </ButtonTool>
          </InputText>
        </FlexItem>
        <Flex width="20px" />
        <SecondaryButton on:buttonClick={onChangeExportPath}>Change</SecondaryButton>
      </Flex>
    </Flex>
  </Flex>

  <Flex height="50px" />
  <Line />
  <Flex height="40px" />

  <Flex>
    <Flex der="column" width="-webkit-fill-available">
      <Label>Graphics (restart required)</Label>
      <select class="ng-select" bind:value={$settings.app.gpuProfile}>
        {#each gpuProfiles as profile}
          <option value={profile.id}>{profile.text}</option>
        {/each}
      </select>
      <CheckBox
        bind:checked={$settings.app.webgpuInstrumentation}
        text="Count WebGPU/WebGL calls in Figma tabs (Help → Diagnostics)"
      />
    </Flex>
    <Flex width="120px" />
    <Flex der="column" width="-webkit-fill-available">
      <Label>Figma Linux NG</Label>
      <CheckBox
        checked={$settings.app.userAgentOS !== "linux"}
        on:change={onUserAgentChange}
        text="Windows user agent for figma.com (Font Agent via Wine)"
      />
      <CheckBox bind:checked={$settings.app.lazyRestoreTabs} text="Load restored tabs when first opened" />
    </Flex>
  </Flex>

  <Flex height="50px" />
  <Line />
  <Flex height="40px" />

  <Flex>
    <Flex der="column" width="-webkit-fill-available">
      <Label>Font directories</Label>
      <ListBox {items} {onItemRemoveClick} height="160px" />
      <Flex height="10px" />
      <Flex>
        <FlexItem grow={1} />
        <SecondaryButton on:buttonClick={onClearList}>Clear list</SecondaryButton>
        <Flex width="10px" />
        <SecondaryButton on:buttonClick={onAddDirectory}>Add directory</SecondaryButton>
      </Flex>
    </Flex>
    <Flex width="120px" />
    <Flex der="column" width="-webkit-fill-available">
      <Label>Chromium command line switches</Label>
      <ListBox items={switchItems} onItemRemoveClick={onSwitchItemRemoveClick} height="160px" />
      <Flex height="10px" />
      <Flex>
        <FlexItem grow={1} />
        <SecondaryButton on:buttonClick={onClearSwicthList}>Clear list</SecondaryButton>
        <Flex width="10px" />
        <SecondaryButton on:buttonClick={onAddSwicth}>Add Switch</SecondaryButton>
      </Flex>
    </Flex>
  </Flex>
</div>

<style>
  .ng-select {
    margin: 4px 0 12px;
    padding: 6px 8px;
    color: var(--text);
    background-color: var(--bg-panel);
    border: 1px solid var(--borders);
    border-radius: 2px;
    font-size: 12px;
  }
  div {
    position: absolute;
    background-color: var(--bg-panel);
    width: -webkit-fill-available;
    padding: 32px 32px 8px 32px;
    user-select: none;
    overflow-y: auto;
    overflow-x: hidden;
  }
</style>
