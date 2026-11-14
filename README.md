# 小学1·2年级韩语推荐书单

线上地址：https://joyzh1029.github.io/korean-booklist/

为目前读一年级、2027年3月升二年级的 LEO 整理的家庭阅读书单与阅读记录。可在木纹书架上选书、标记已读并打分，也可在「我的图书馆」查看月度统计和阅读记录。

输入家庭密码后，已读、星级和认证日会通过 Cloudflare Worker 在平板和手机之间自动同步。不输入密码也可以先在本机使用（键名 `leo-korean-booklist-v1`）。本站不含读后测验。

封面于 2026-11-15（韩国首尔时间）从 알라딘 / 교보문고 约 500 像素原图下载，保存为约 300 像素宽的图片。部分书使用近年再版封面。

同步接口：https://leo-korean-booklist.joyzh1029.workers.dev （源码在 `worker/`）。家庭密码保存在 Worker 密钥 `BOOKLIST_PASSCODE` 中，不要写入本仓库。
