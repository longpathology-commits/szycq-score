# 守正亦出齐 — A股多因子实时评分站（静态部署包）

本目录是可直接托管的纯静态站点（无需后端、无需数据库）。

## 文件说明
- `index.html` / `app.js` / `watchstore.js`：评分首页 + 标记框
- `hold.html` / `hold.js`：持仓页
- `all.html` / `all.js`：全市场浏览
- `data/b/00.json.gz`：全市场 5002 只股票评分数据（单桶 gzip）
- `data/backup/cloud_backup.json`：云端备份（初始为空）
- `ranking.json` / `all.json` / `name_index.json`：排行榜/索引
- `health.json`：保活探针

## 部署方式（三选一，均免费）
1. **Netlify 拖拽（最省事）**：打开 app.netlify.com/drop ，把本目录拖进去即可，秒得常驻网址。
2. **Vercel 拖拽/连 Git**：vercel.com → New Project → 拖拽本目录或连 Git 仓库。
3. **GitHub Pages**：需把本目录推到你的 GitHub 仓库，仓库 Settings → Pages 选分支根目录。

> 国内访问：GitHub Pages 在大陆常不稳定，优先 Netlify / Vercel。

## 重要：云端备份在纯静态托管下的变化
本站在 CloudStudio 时，「备份到云端」由助手直接写服务器文件。迁到纯静态托管后：
- 仍可「导出/导入」按钮在浏览器本地备份（首选，零依赖）；
- 「备份到云端」需改为：你在页面点备份 → 把数据发助手 → 助手写入 `data/backup/cloud_backup.json` → 重新部署（拖拽/推送）后生效。

## 数据更新
评分慢变量由本地 `web/refresh.js` + `web/sync_deploy.js` 重新生成 `web/deploy`，再重新部署即可。
