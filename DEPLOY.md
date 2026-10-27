# 云端部署指南 - Render

## 准备工作

1. 注册 GitHub 账号（如果还没有）：https://github.com
2. 注册 Render 账号（用 GitHub 登录）：https://render.com

## 步骤

### 第1步：上传代码到 GitHub

```bash
# 在项目根目录执行
cd group-reminder-app
git init
git add .
git commit -m "Initial commit"

# 在 GitHub 上创建一个仓库（不要初始化 README）
# 然后执行：
git remote add origin https://github.com/你的用户名/group-reminder-app.git
git push -u origin main
```

### 第2步：在 Render 上部署

1. 登录 [render.com](https://render.com)
2. 点击 "New +" → "Web Service"
3. 连接你的 GitHub 仓库 `group-reminder-app`
4. 填写配置：
   - **Name**: group-reminder-app
   - **Region**: Singapore（离你最近）
   - **Branch**: main
   - **Runtime**: Python 3
   - **Build Command**: `cd backend && pip install -r requirements.txt`
   - **Start Command**: `cd backend && python main.py`
   - **Plan**: Free
5. 点击 "Create Web Service"

### 第3步：等待部署完成

- 首次部署需要 2-3 分钟
- 部署成功后，Render 会给你一个链接：`https://group-reminder-app-xxxxx.onrender.com`
- 点击链接即可访问

### 第4步：分享给女朋友

- 直接把 Render 的链接发给她
- 她用手机浏览器打开就能用
- 建议添加到主屏幕，像 App 一样使用

## 注意事项

1. **免费版限制**：
   - 15分钟无访问会自动休眠，下次访问需要 30 秒左右启动
   - 每月有一定免费额度，个人使用完全够用

2. **数据持久化**：
   - SQLite 数据库保存在实例磁盘上
   - 只要不删除实例，数据就不会丢失
   - 建议定期导出备份（可在页面点击下载数据库）

3. **自定义域名（可选）**：
   - Render 支持绑定自定义域名
   - 在 Dashboard → Settings → Custom Domains 中配置

## 更新代码

修改代码后，推送到 GitHub，Render 会自动重新部署：

```bash
git add .
git commit -m "Update"
git push
```
