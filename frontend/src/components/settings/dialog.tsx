"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuBrain,
  LuBriefcase,
  LuKey,
  LuKeyRound,
  LuLock,
  LuUser,
  LuUsers,
} from "react-icons/lu";
import SettingsModal, { type SettingsTabItem } from "./modal";
import WorkspaceSelector from "./workspace-selector";
import WorkspaceTab from "./tabs/WorkspaceTab";
import TeamTab from "./tabs/TeamTab";
import ProviderKeysTab from "./tabs/ProviderKeysTab";
import VMSecretsTab from "./tabs/VMSecretsTab";
import ProfileTab from "./tabs/ProfileTab";
import PersonalizationTab from "./tabs/PersonalizationTab";
import SecurityTab from "./tabs/SecurityTab";
import useSettingsStore, { type SettingsTab } from "@/stores/settings";
import useWorkspacesStore, { type WorkspaceSettingsTab } from "@/stores/workspaces";
import frontendExtension from "@cloud";

const TAB_IDS: readonly string[] = [
  "workspace",
  "team",
  "provider-keys",
  "secrets",
  ...frontendExtension.settingsTabs.map((tab) => tab.id),
  "profile",
  "personalization",
  "security",
];

export default function SettingsDialog() {
  const { t } = useTranslation(["settings", "common"]);
  const {
    settingsDialogOpen,
    setSettingsDialogOpen,
    settingsDialogTab,
    setSettingsDialogTab,
  } = useSettingsStore();

  const {
    isWorkspaceSettingsDialogOpen,
    setWorkspaceSettingsDialogOpen,
    workspaceSettingsTab,
    setWorkspaceSettingsTab,
    currentWorkspace,
  } = useWorkspacesStore();

  const isOpen = settingsDialogOpen || isWorkspaceSettingsDialogOpen;

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (isWorkspaceSettingsDialogOpen) return workspaceSettingsTab;
    return settingsDialogTab || "workspace";
  });

  const initialTabSet = useRef(false);
  const lastStoreTabRef = useRef<SettingsTab>(settingsDialogTab);

  useEffect(() => {
    if (isOpen && !initialTabSet.current) {
      initialTabSet.current = true;
      const hash = window.location.hash.slice(1);
      if (hash && TAB_IDS.includes(hash as SettingsTab)) {
        setActiveTab(hash as SettingsTab);
        setSettingsDialogTab(hash as SettingsTab);
        lastStoreTabRef.current = hash as SettingsTab;
      } else if (isWorkspaceSettingsDialogOpen && workspaceSettingsTab) {
        setActiveTab(workspaceSettingsTab);
        setSettingsDialogTab(workspaceSettingsTab);
        lastStoreTabRef.current = workspaceSettingsTab;
      } else if (settingsDialogTab) {
        setActiveTab(settingsDialogTab);
        lastStoreTabRef.current = settingsDialogTab;
      }
      return;
    }
    if (isOpen && settingsDialogTab !== lastStoreTabRef.current) {
      lastStoreTabRef.current = settingsDialogTab;
      if (TAB_IDS.includes(settingsDialogTab)) {
        setActiveTab(settingsDialogTab);
        window.location.hash = settingsDialogTab;
      }
    }
  }, [
    isOpen,
    isWorkspaceSettingsDialogOpen,
    workspaceSettingsTab,
    settingsDialogTab,
    setSettingsDialogTab,
  ]);

  const workspaceTabIds = useMemo(
    () => [
      "workspace",
      "team",
      "provider-keys",
      "secrets",
      ...frontendExtension.settingsTabs
        .filter((tab) => tab.sectionKey === "workspace")
        .map((tab) => tab.id),
    ],
    []
  );

  const handleTabChange = (id: SettingsTab) => {
    lastStoreTabRef.current = id;
    setActiveTab(id);
    setSettingsDialogTab(id);
    if (workspaceTabIds.includes(id)) {
      setWorkspaceSettingsTab(id as WorkspaceSettingsTab);
    }
    window.location.hash = id;
  };

  const handleOpenChange = (open: boolean) => {
    setSettingsDialogOpen(open);
    setWorkspaceSettingsDialogOpen(open);
    if (!open) {
      if (window.location.hash) {
        window.location.hash = "";
      }
      initialTabSet.current = false;
    }
  };

  const translatedTabs = useMemo<readonly SettingsTabItem<SettingsTab>[]>(
    () => [
      { id: "workspace", label: t("common:settings.tabs.workspace"), icon: LuBriefcase, section: t("common:settings.sections.workspace") },
      { id: "team", label: t("common:settings.tabs.team"), icon: LuUsers, section: t("common:settings.sections.workspace") },
      { id: "provider-keys", label: t("common:settings.tabs.providerKeys"), icon: LuKey, section: t("common:settings.sections.workspace") },
      { id: "secrets", label: t("common:settings.tabs.vmSecrets"), icon: LuKeyRound, section: t("common:settings.sections.workspace") },
      ...frontendExtension.settingsTabs
        .filter((tab) => tab.sectionKey === "workspace")
        .map((tab) => ({
          id: tab.id as SettingsTab,
          label: t(tab.labelKey as any) as string,
          icon: tab.icon,
          section: t("common:settings.sections.workspace"),
        })),
      { id: "profile", label: t("common:settings.tabs.profile"), icon: LuUser, section: t("common:settings.sections.account") },
      { id: "personalization", label: t("common:settings.tabs.personalization"), icon: LuBrain, section: t("common:settings.sections.account") },
      { id: "security", label: t("common:settings.tabs.security"), icon: LuLock, section: t("common:settings.sections.account") },
      ...frontendExtension.settingsTabs
        .filter((tab) => tab.sectionKey === "account")
        .map((tab) => ({
          id: tab.id as SettingsTab,
          label: t(tab.labelKey as any) as string,
          icon: tab.icon,
          section: t("common:settings.sections.account"),
        })),
    ],
    [t]
  );

  return (
    <SettingsModal
      open={isOpen}
      onOpenChange={handleOpenChange}
      title={t("common:settings.title")}
      description={t("dialog.description")}
      tabs={translatedTabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      workspaceSelector={isOpen ? <WorkspaceSelector /> : null}
    >
      <div key={`${currentWorkspace?.uuid || "workspace"}:${activeTab}`}>
        {renderTabContent(activeTab)}
      </div>
    </SettingsModal>
  );
}

function renderTabContent(tab: SettingsTab) {
  switch (tab) {
    case "workspace":
      return <WorkspaceTab />;
    case "team":
      return <TeamTab />;
    case "provider-keys":
      return <ProviderKeysTab />;
    case "secrets":
      return <VMSecretsTab />;
    case "profile":
      return <ProfileTab />;
    case "personalization":
      return <PersonalizationTab />;
    case "security":
      return <SecurityTab />;
    default: {
      const extTab = frontendExtension.settingsTabs.find((item) => item.id === tab);
      if (extTab) {
        const ExtComponent = extTab.Component;
        return <ExtComponent />;
      }
      return null;
    }
  }
}
