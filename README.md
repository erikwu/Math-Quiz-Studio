# Local Math Quiz App

本项目是一个本地运行的 Node.js 数学练习系统，支持：

- 用户名和密码登录
- 管理员创建、编辑、删除学生账号
- 从 `data/questions.json` 随机抽取并打乱题目顺序
- 左边题目、右边选项的答题布局
- 上一题、下一题、跳题
- 确认交卷后自动判分
- 保存做题记录到 `data/attempts.json`
- 根据历史错题自动生成错题本
- 图形题使用 SVG 重绘显示

## 默认账号

- 管理员：`admin` / `admin1234`
- 学生：`student` / `math1234`

账号数据在 `data/users.json`。

## 运行方式

在项目目录执行：

```bash
node server.js
```

或者直接双击 `start.bat`。

浏览器打开：

```text
http://localhost:3000
```

## 数据文件

- `data/questions.json`：题库
- `data/users.json`：账号
- `data/attempts.json`：历史交卷记录

## 说明

- 题目按你提供的 `Page 1` 到 `Page 6` 顺序整理
- 纯文字题保留英文题干和选项
- 图形题已经改为更接近原题的 SVG 版本，方便在网页里直接显示
