# DSH Boot Animation Plus

缁?DeepSeek Harness锛圖SH锛夊姞涓€涓€屾墦寮€灏辨湁鐗囧ご鍔ㄧ敾銆嶇殑寮€鏈烘晥鏋滐細姣忔鎵撳紑 DSH銆佹墦寮€鏂颁細璇濓紝鎴栨瘡娆¤繘鍏ヤ綘**閽変綇**鐨勯偅涓細璇濇椂锛屾弧绐楀彛鎾竴娈电墖澶村姩鐢伙紝鍐嶆贰鍑鸿繘鍏ュ伐浣滃尯銆?
杩欐槸 [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) 鐨勭ぞ鍖?fork锛圔SD-3-Clause锛夛紝鍦ㄤ繚鐣欎笂娓稿叏閮ㄨ兘鍔涚殑鍩虹涓婂鍔犱簡**鐗囧簱鎵归噺鍒犻櫎**銆?
> English: see [README.en.md](README.en.md).

![Splash illustration](docs/images/splash.png)

*示意图：开屏播放时整屏都是片头，按 Esc 可跳过。图片由 docs/images/generate.py 用代码生成，不是截图，也不含任何真实数据。*

![Clip library illustration](docs/images/library.png)

*示意图：片库支持多选、全选/清空与确认删除；内置片头不可删除，你自己加入的视频会同步删除文件。*

## 鍔熻兘

- **鍐呯疆 4 娈?DeepSeek 鐗囧ご**锛氬搧鐗屻€佽禌鍗氭湅鍏嬨€佹暟瀛楄鑹茶嫃閱掋€佸惎鍔ㄧ墖澶淬€傚叏閮?*宓屽叆鍦ㄤ唬鐮侀噷**锛坄lib/clips.data.js`锛夛紝瀹夎鍚庝笉渚濊禆浠讳綍澶栭儴瑙嗛鏂囦欢銆?- **鐗囧簱闈㈡澘**锛氬垏鎹㈠唴缃墖澶淬€侀瑙堥€変腑椤广€佹妸浣犺嚜宸辩殑瑙嗛鍔犺繘鐗囧簱锛涙敮鎸併€岄『搴?/ 闅忔満 / 鍗曟銆嶆挱鏀句笌閫傞厤鏂瑰紡锛坈over / contain锛夈€?- **鎸変細璇濋拤浣?*锛氭妸鏌愪釜浼氳瘽閽変綇鍚庯紝姣忔杩涘叆瀹冮兘閲嶆挱锛堟柊浼氳瘽鍒欐寜鍏ㄥ眬璁剧疆锛夈€?- **鏈?fork 鏂板锛氭壒閲忓垹闄?* 鈥斺€?鐗囧簱鏀寔澶氶€夈€佸叏閫?娓呯┖锛岀‘璁ゅ悗**鍚屾鍒犻櫎**浣犺嚜宸卞姞鍏ョ殑瑙嗛鏂囦欢锛堝唴缃墖澶翠笉鍙垹锛屽垹闄ゅ墠鏈変簩娆＄‘璁わ級銆?- **鍙€夋杩庡眰**锛氬湪鐗囧ご涔嬩笂鍙犲姞涓€灞傛杩庣晫闈紙鏂囧瓧鍙嚜瀹氫箟锛夛紝**榛樿鍏抽棴**锛屽枩娆㈢函瑙嗛鐨勫悓瀛︿笉鐢ㄧ瀹冦€?
## 瀹夎

DSH Desktop 鍙互鍦?**Settings 鈫?Plugins** 鐨勫畨瑁呮閲屽～ GitHub 鍦板潃锛屾垨鑰呯敤鍛戒护琛岋細

```bash
dsh plugin --profile desktop add github:BuildWithAIHub/dsh-boot-animation-plus
```

鏅€?`dsh web` 鎶?`desktop` 鎹㈡垚浣犵殑 profile 鍚嶏紙甯歌鏄?`web`锛夈€傚畨瑁呭悗鍒锋柊椤甸潰鎴栭噸鍚?DSH銆?
瑕佹眰锛欴SH `>= 0.1.5-rc.1`锛坄package.json` 鐨?`dsh.engines.dsh`锛夛紝Node.js `>= 20`銆?
## 涓庝笂娓哥殑宸紓

| 椤?| 涓婃父 dsh-boot-animation | 鏈?fork |
|---|---|---|
| 鐗囧簱鎵归噺鍒犻櫎 | 鏃?| 鉁?澶氶€?/ 鍏ㄩ€?/ 纭鍒犻櫎锛屽悓鏃跺垹闄ょ敤鎴疯棰戞枃浠?|
| 鍐呯疆鐗囧ご | 4 娈?DeepSeek 鐗囧ご | 鐩稿悓 4 娈碉紝涓嶅啀鍖呭惈绗笁鏂规父鎴忕墖澶?|
| 娆㈣繋灞?| 榛樿寮€鍚?| 榛樿**鍏抽棴**锛堢函瑙嗛浣撻獙锛?|
| 鍖呭悕 | `dsh-boot-animation` | `dsh-boot-animation-plus`锛堥伩鍏嶄笌涓婃父鍐茬獊锛?|

## 寮€鍙?
```bash
npm run build     # 鏋勫缓 lib/锛堝惈鎶?media/*.mp4 宓屽叆 lib/clips.data.js锛?npm run check     # 22 缁勬牎楠岃剼鏈?```

鏋勫缓浜х墿 `lib/` 宸叉彁浜ゅ湪浠撳簱閲岋紝鎵€浠ヤ粠婧愮爜瀹夎鏃?*涓嶄細**瑙﹀彂浠讳綍鏋勫缓鑴氭湰銆?
## 闅愮

- 鎻掍欢鍙鍐欐湰鍦?DSH 閰嶇疆鍜岃棰戠洰褰曪紝涓嶅彂閫佷换浣曠綉缁滆姹傦紱
- 娌℃湁閬ユ祴銆佺粺璁℃垨璐﹀彿鐩稿叧浠ｇ爜銆?
## 璁稿彲涓庣礌鏉?
- 浠ｇ爜锛欱SD-3-Clause锛岃 [LICENSE](LICENSE)锛涗笂娓哥増鏉冨綊 NativeDog1/dsh-boot-animation锛岃 [NOTICE.md](NOTICE.md)銆?- 鍐呯疆鐨?4 娈电墖澶磋棰戞潵鑷?DSH/DeepSeek 鍝佺墝绱犳潗锛岀増鏉冨綊鏉冨埄浜烘墍鏈夛紝浠呴殢鎻掍欢浣滀负寮€灞忔紨绀哄垎鍙戯紱濡傛潈鍒╀汉瑕佹眰浼氱珛鍗崇Щ闄ゃ€?