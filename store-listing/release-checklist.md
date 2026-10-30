# Chrome Web Store 发布检查清单

## 开发者账户

- [ ] 注册 Chrome Web Store 开发者账户并完成一次性费用
- [ ] 开启 Google 账户两步验证
- [ ] 核对开发者名称、联系邮箱和支持渠道

## Package

- [ ] 上传 `dist/multi-ai-chat-1.0.2.zip`
- [ ] 确认 manifest 解析成功且版本号未与已发布版本重复
- [ ] 确认 ZIP 仅包含 `manifest.json`、`src/` 和 `assets/icons/`

## Store Listing

- [ ] 复制 `store-listing/zh-CN.md` 中的名称、简短说明和详细说明
- [ ] 分类选择 Productivity
- [ ] 语言选择简体中文
- [ ] 上传 `store-assets/store-icon-128.png`
- [ ] 上传至少一张 1280×800 截图
- [ ] 上传 `store-assets/promo-small-440x280.png`
- [ ] 可选上传 `store-assets/promo-marquee-1400x560.png`
- [ ] 填写主页和支持 URL

## Privacy

- [ ] 按 `store-listing/privacy-dashboard.md` 填写单一用途和每项权限说明
- [ ] Remote code 选择 No
- [ ] 如实勾选认证信息、个人通信、用户生成内容、网页内容、浏览历史
- [ ] 完成 Limited Use 认证
- [ ] 填写公开可访问的 `PRIVACY.md` URL

## Test instructions

- [ ] 粘贴 `store-listing/reviewer-notes.md`
- [ ] 明确无需开发者账号，审核人员可用匿名状态或自己的测试账号

## 提交前

- [ ] 本地重新加载未打包扩展，首次同意页与隐私入口均可用
- [ ] 分别验证 Cookie 关闭和开启状态
- [ ] 验证至少两个站点可发送、显示回答并复制
- [ ] 确认商店截图不含真实账号、历史对话或个人信息
- [ ] 检查描述、隐私政策与实际代码一致
- [ ] 选择延迟发布，先等审核通过再手动上线
