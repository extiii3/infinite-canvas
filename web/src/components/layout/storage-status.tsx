import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { App, Button, Popover } from "antd";
import { Cloud, CloudOff, HardDrive, LoaderCircle, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getSyncStatus, subscribeSyncStatus } from "@/lib/server-storage/status";
import { cn } from "@/lib/utils";

const TEXT = {
    zh: {
        cloud: "云端",
        syncing: "同步中",
        offline: "离线",
        local: "仅本地",
        cloudTitle: "数据保存在云端服务器",
        localTitle: "数据只保存在此浏览器",
        cloudDesc: "画布、素材、生成记录、图片视频和模型配置都保存在服务器（Railway 存储卷 /data/server），所有登录用户共享。此浏览器只保留一份缓存，用于加速和离线编辑。",
        localDesc: "未检测到存储服务器，数据只在当前浏览器的 IndexedDB 中。",
        offlineDesc: "暂时连不上服务器。可以继续编辑，恢复连接后会自动上传。",
        pending: (n: number) => `${n} 项待上传`,
        allSynced: "全部已同步",
        lastSync: "最近同步",
        server: (k: number, f: number, size: string) => `服务器上共 ${k} 项，其中 ${f} 个图片/视频文件，${size}`,
        logout: "退出登录",
        loggingOut: "正在保存并退出…",
        unsyncedTitle: "还有未上传的修改",
        unsyncedBody: (n: number) => `有 ${n} 项修改还没上传到服务器，现在退出会丢失。仍要退出吗？`,
        confirm: "仍然退出",
        cancel: "取消",
    },
    en: {
        cloud: "Cloud",
        syncing: "Syncing",
        offline: "Offline",
        local: "Local only",
        cloudTitle: "Data is stored on the cloud server",
        localTitle: "Data is stored in this browser only",
        cloudDesc: "Canvases, assets, history, images, videos and provider settings are saved on the server (Railway volume /data/server) and shared by everyone who signs in. This browser keeps a cache for speed and offline editing.",
        localDesc: "No storage server detected; data lives only in this browser's IndexedDB.",
        offlineDesc: "Can't reach the server right now. Keep working; changes upload automatically when it's back.",
        pending: (n: number) => `${n} change${n === 1 ? "" : "s"} waiting to upload`,
        allSynced: "Everything is synced",
        lastSync: "Last synced",
        server: (k: number, f: number, size: string) => `Server holds ${k} items, including ${f} image/video files, ${size}`,
        logout: "Sign out",
        loggingOut: "Saving and signing out…",
        unsyncedTitle: "Unsynced changes",
        unsyncedBody: (n: number) => `${n} change${n === 1 ? " hasn't" : "s haven't"} reached the server yet and will be lost. Sign out anyway?`,
        confirm: "Sign out anyway",
        cancel: "Cancel",
    },
};

const formatBytes = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`);

type Props = { iconClass: string; style?: CSSProperties };

export function StorageStatus({ iconClass, style }: Props) {
    const { i18n } = useTranslation();
    const { modal } = App.useApp();
    const text = i18n.resolvedLanguage === "zh-CN" ? TEXT.zh : TEXT.en;
    const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
    const [stats, setStats] = useState<{ keys: number; files: number; bytes: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const cloud = status.mode === "cloud";

    const state = !cloud ? "local" : !status.online ? "offline" : status.pending > 0 ? "syncing" : "cloud";
    const label = { cloud: text.cloud, syncing: text.syncing, offline: text.offline, local: text.local }[state];
    const dot = { cloud: "bg-emerald-500", syncing: "bg-sky-500", offline: "bg-amber-500", local: "bg-stone-400" }[state];
    const Icon = state === "local" ? HardDrive : state === "offline" ? CloudOff : state === "syncing" ? LoaderCircle : Cloud;

    const loadStats = async (open: boolean) => {
        if (!open || !cloud) return;
        const { storageApi } = await import("@/lib/server-storage/client");
        storageApi.stats().then(setStats, () => setStats(null));
    };

    const signOut = async () => {
        setBusy(true);
        const { flushNow, clearLocalCache } = await import("@/lib/server-storage/core");
        const unsynced = await flushNow(8000);
        if (unsynced > 0) {
            const proceed = await new Promise<boolean>((resolve) =>
                modal.confirm({ title: text.unsyncedTitle, content: text.unsyncedBody(unsynced), okText: text.confirm, cancelText: text.cancel, okButtonProps: { danger: true }, onOk: () => resolve(true), onCancel: () => resolve(false) }),
            );
            if (!proceed) {
                setBusy(false);
                return;
            }
        }
        const { clearMirroredLocal } = await import("@/lib/server-storage/mirror");
        clearMirroredLocal();
        await clearLocalCache([["infinite-canvas", "image_previews"]]);
        window.location.assign("/cdn-cgi/access/logout"); // Cloudflare Access ends the session
    };

    const content = (
        <div className="w-72 space-y-2 text-xs leading-relaxed">
            <div className="text-sm font-medium">{cloud ? text.cloudTitle : text.localTitle}</div>
            <p className="text-stone-500">{cloud ? text.cloudDesc : text.localDesc}</p>
            {cloud ? (
                <>
                    {state === "offline" ? <p className="text-amber-600">{text.offlineDesc}</p> : null}
                    <div>{status.pending > 0 ? text.pending(status.pending) : text.allSynced}</div>
                    {status.lastSyncAt ? (
                        <div className="text-stone-500">
                            {text.lastSync}: {new Date(status.lastSyncAt).toLocaleTimeString()}
                        </div>
                    ) : null}
                    {stats ? <div className="text-stone-500">{text.server(stats.keys, stats.files, formatBytes(stats.bytes))}</div> : null}
                    <Button block danger icon={<LogOut className="size-3.5" />} loading={busy} onClick={() => void signOut()}>
                        {busy ? text.loggingOut : text.logout}
                    </Button>
                </>
            ) : null}
        </div>
    );

    return (
        <>
            <Popover content={content} trigger="click" placement="bottomRight" onOpenChange={(open) => void loadStats(open)}>
                <button type="button" className={cn(iconClass, "w-auto gap-1.5 px-2 text-[11px] font-medium")} style={style} aria-label={label} title={label}>
                    <span className={`size-1.5 rounded-full ${dot}`} />
                    <Icon className={state === "syncing" ? "animate-spin" : undefined} />
                    <span className="hidden sm:inline">
                        {label}
                        {state !== "cloud" && state !== "local" && status.pending > 0 ? ` ${status.pending}` : ""}
                    </span>
                </button>
            </Popover>
            {cloud ? (
                <button type="button" className={iconClass} style={style} onClick={() => void signOut()} disabled={busy} aria-label={text.logout} title={text.logout}>
                    {busy ? <LoaderCircle className="animate-spin" /> : <LogOut />}
                </button>
            ) : null}
        </>
    );
}
