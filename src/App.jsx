import { useState, useEffect } from "react";
import {
  Play,
  RefreshCw,
  ImageIcon,
  FileText,
  AlertCircle,
  Loader2,
  Sparkles,
  Edit3,
  Wand2,
  Settings,
  Sliders,
  Layout,
  Moon,
  Sun,
  Github,
} from "lucide-react";

import { getTheme, LAYOUTS } from "@/constants";
import { dbUtils, sleep, concurrentLimit } from "@/utils";
import { callTextAI, callImageAI } from "@/services";
import {
  useApiConfig,
  usePptLib,
  useCooldown,
  useLogs,
  useTheme,
  useAuth,
} from "@/hooks";
import { SettingsModal, PreviewSection } from "@/components";

export default function App() {
  const [stage, setStage] = useState("input");
  const [inputMode, setInputMode] = useState("topic");
  const [inputValue, setInputValue] = useState("");
  const [targetSlideCount, setTargetSlideCount] = useState(8);
  const [slides, setSlides] = useState([]);
  const [currentProcessIndex, setCurrentProcessIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState(null);
  const [regeneratingIds, setRegeneratingIds] = useState({});
  const [showSettings, setShowSettings] = useState(false);

  const { apiConfig, saveConfig } = useApiConfig();
  const pptLibReady = usePptLib();
  const { cooldownTime, setCooldownTime } = useCooldown();
  const { logs, addLog } = useLogs();
  const { isDark, toggleTheme } = useTheme();
  const { isAuthenticated, login, requiresAuth } = useAuth();
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState(false);
  const THEME = getTheme(isDark);

  useEffect(() => {
    dbUtils.clear();
  }, []);

  const handleAnalyze = async () => {
    if (!inputValue.trim()) return;
    setStage("analyzing");
    setErrorMsg(null);
    addLog(
      "AI 编剧",
      inputMode === "topic"
        ? `正在构思 ${targetSlideCount} 页大纲...`
        : "正在拆解文章结构...",
      "accent",
    );
    const systemPrompt = `你是一个PPT设计专家。请分析用户的输入，并生成一个包含 **${targetSlideCount}页** 的幻灯片结构化 JSON。要求：1. 严格返回 JSON 格式。2. 幻灯片数量必须正好是 ${targetSlideCount} 页。3. 为每一页选择最合适的排版 (layout)，可选值: "cover", "split_right", "split_left", "glass", "minimal"。4. 生成具体的 imagePrompt (绘画提示词)，必须是英文，包含风格描述。5. 内容 (content) 数组中每项不超过 20 字，精炼有力。JSON 格式示例:{ "title": "Main Title", "slides": [ { "id": 1, "layout": "cover", "title": "...", "content": ["..."], "imagePrompt": "..." } ] }`;
    try {
      const prompt = `用户输入: "${inputValue.slice(0, 3000)}"`;
      const parsed = await callTextAI(prompt, systemPrompt, apiConfig);
      setSlides(
        parsed.slides.map((s) => ({
          ...s,
          status: "pending",
          hasImage: false,
        })),
      );
      addLog("AI 编剧", "结构规划完成，请确认大纲", "success");
      setStage("edit_outline");
    } catch (err) {
      console.error(err);
      setErrorMsg("分析失败，请检查 API 设置");
      setStage("input");
    }
  };

  const regenerateSlideImage = async (slideIndex) => {
    const slide = slides[slideIndex];
    if (!slide) return;
    setSlides((prev) =>
      prev.map((s, idx) =>
        idx === slideIndex ? { ...s, status: "generating" } : s,
      ),
    );
    addLog("AI 画师", `正在重绘第 ${slideIndex + 1} 页配图...`, "info");
    try {
      const b64 = await callImageAI(slide.imagePrompt, apiConfig);
      await dbUtils.save(`slide-${slide.id}`, b64);
      setSlides((prev) =>
        prev.map((s, idx) =>
          idx === slideIndex
            ? { ...s, status: "done", hasImage: true, lastUpdated: Date.now() }
            : s,
        ),
      );
      addLog("AI 画师", `第 ${slideIndex + 1} 页重绘完成`, "success");
    } catch (err) {
      setSlides((prev) =>
        prev.map((s, idx) =>
          idx === slideIndex ? { ...s, status: "error" } : s,
        ),
      );
      addLog("错误", err.message, "error");
      if (err.message.includes("RATE_LIMIT")) setCooldownTime(15);
    }
  };

  const rewriteSlideContent = async (slideIndex) => {
    const slide = slides[slideIndex];
    setRegeneratingIds((prev) => ({ ...prev, [slide.id]: "text" }));
    addLog("AI 编剧", `正在润色第 ${slideIndex + 1} 页文案...`, "info");
    const prompt = `用户对这页PPT的内容不满意，请重新优化文案。当前标题: "${slide.title}" 当前内容: ${JSON.stringify(slide.content)} 当前布局: ${slide.layout} 要求: 1. 返回 JSON: { "title": "新标题", "content": ["点1", "点2"...] } 2. 语气更专业、精炼。 3. 适配布局（如果是封面则字少，列表页则点多）。`;
    try {
      const parsed = await callTextAI(prompt, "", apiConfig);
      setSlides((prev) =>
        prev.map((s, idx) =>
          idx === slideIndex
            ? { ...s, title: parsed.title, content: parsed.content }
            : s,
        ),
      );
      addLog("AI 编剧", "文案优化完成", "success");
    } catch (e) {
      addLog("错误", "文案优化失败", "error");
    } finally {
      setRegeneratingIds((prev) => {
        const newState = { ...prev };
        delete newState[slide.id];
        return newState;
      });
    }
  };

  const handleBatchGeneration = async () => {
    setStage("generating_images");
    addLog(
      "AI 画师",
      `开始并发渲染(最多5张)，使用引擎: ${apiConfig.image.provider === "system" ? "Imagen" : "Custom"}`,
      "info",
    );

    const slidesToGenerate = slides
      .map((slide, index) => ({ slide, index }))
      .filter(({ slide }) => !slide.hasImage);

    if (slidesToGenerate.length === 0) {
      setStage("preview");
      return;
    }

    setSlides((prev) =>
      prev.map((s) => (!s.hasImage ? { ...s, status: "generating" } : s)),
    );

    const results = await concurrentLimit(
      slidesToGenerate,
      async ({ slide, index }) => {
        setCurrentProcessIndex(index);
        const b64 = await callImageAI(slide.imagePrompt, apiConfig);
        console.log(
          `[DEBUG] 第${index + 1}页图片生成成功，数据长度: ${b64?.length || 0}`,
        );
        await dbUtils.save(`slide-${slide.id}`, b64);
        console.log(`[DEBUG] 第${index + 1}页图片已保存到IndexedDB`);
        return { index, slideId: slide.id };
      },
      5,
    );

    results.forEach((result) => {
      if (result.status === "fulfilled") {
        const { index, slideId } = result.value;
        setSlides((prev) =>
          prev.map((s) =>
            s.id === slideId ? { ...s, status: "done", hasImage: true } : s,
          ),
        );
        addLog("AI 画师", `第 ${index + 1} 页渲染完成`, "success");
      } else {
        const err = result.reason;
        console.error(`[DEBUG] 图片生成失败:`, err);
        addLog("错误", err.message, "error");
      }
    });

    setStage("preview");
  };

  const handleExport = async () => {
    if (!window.PptxGenJS) return;
    setStage("exporting");
    try {
      const pptx = new window.PptxGenJS();
      pptx.layout = "LAYOUT_16x9";
      for (const slide of slides) {
        const pptSlide = pptx.addSlide();
        const b64 = await dbUtils.get(`slide-${slide.id}`);

        if (["minimal", "split_right", "split_left"].includes(slide.layout)) {
          pptSlide.background = {
            color: slide.layout === "minimal" ? "FFFFFF" : "F8FAFC",
          };
          if (b64) {
            const imgOpts = {
              x:
                slide.layout === "split_left"
                  ? 0
                  : slide.layout === "minimal"
                    ? "66%"
                    : "50%",
              y: 0,
              w: slide.layout === "minimal" ? "34%" : "50%",
              h: "100%",
              sizing: { type: "cover" },
            };
            pptSlide.addImage({ data: b64, ...imgOpts });
          }
        } else {
          if (b64) pptSlide.background = { data: b64 };
          if (slide.layout === "cover")
            pptSlide.addShape(pptx.ShapeType.rect, {
              x: 0,
              y: 0,
              w: "100%",
              h: "100%",
              fill: { color: "000000", transparency: 40 },
            });
        }

        const textCommon = { fontFace: "Microsoft YaHei" };
        if (slide.layout === "cover") {
          pptSlide.addText(slide.title, {
            ...textCommon,
            x: 0,
            y: 2,
            w: "100%",
            h: 1,
            align: "center",
            fontSize: 48,
            color: "FFFFFF",
            bold: true,
          });
          pptSlide.addText(slide.content.join("\n"), {
            ...textCommon,
            x: 1,
            y: 3.5,
            w: "80%",
            h: 2,
            align: "center",
            fontSize: 20,
            color: "F1F5F9",
          });
        } else if (slide.layout === "split_right") {
          pptSlide.addText(slide.title, {
            ...textCommon,
            x: 0.5,
            y: 0.5,
            w: "45%",
            h: 1,
            fontSize: 32,
            color: "0F766E",
            bold: true,
          });
          pptSlide.addText(slide.content.map((c) => `• ${c}`).join("\n"), {
            ...textCommon,
            x: 0.5,
            y: 1.8,
            w: "40%",
            h: 4,
            fontSize: 16,
            color: "334155",
            lineSpacing: 30,
          });
        } else if (slide.layout === "split_left") {
          pptSlide.addText(slide.title, {
            ...textCommon,
            x: 5.5,
            y: 0.5,
            w: "45%",
            h: 1,
            fontSize: 32,
            color: "0F766E",
            bold: true,
          });
          pptSlide.addText(slide.content.map((c) => `• ${c}`).join("\n"), {
            ...textCommon,
            x: 5.5,
            y: 1.8,
            w: "40%",
            h: 4,
            fontSize: 16,
            color: "334155",
            lineSpacing: 30,
          });
        } else if (slide.layout === "glass") {
          pptSlide.addShape(pptx.ShapeType.rect, {
            x: 0.5,
            y: 0.5,
            w: "45%",
            h: 6.5,
            fill: { color: "FFFFFF", transparency: 10 },
          });
          pptSlide.addText(slide.title, {
            ...textCommon,
            x: 0.8,
            y: 0.8,
            w: "40%",
            h: 1,
            fontSize: 32,
            color: "FFFFFF",
            bold: true,
          });
          pptSlide.addText(slide.content.map((c) => `• ${c}`).join("\n"), {
            ...textCommon,
            x: 0.8,
            y: 2,
            w: "40%",
            h: 4,
            fontSize: 16,
            color: "FFFFFF",
            lineSpacing: 30,
          });
        } else if (slide.layout === "minimal") {
          pptSlide.addText(slide.title, {
            ...textCommon,
            x: 0.5,
            y: 0.5,
            w: "60%",
            h: 1,
            fontSize: 36,
            color: "0F172A",
            bold: true,
          });
          pptSlide.addText(slide.content.map((c) => `• ${c}`).join("\n"), {
            ...textCommon,
            x: 0.5,
            y: 1.8,
            w: "55%",
            h: 4,
            fontSize: 18,
            color: "334155",
            lineSpacing: 30,
          });
        }
      }
      await pptx.writeFile({ fileName: `UniquePPT_${Date.now()}.pptx` });
      setStage("preview");
      addLog("系统", "导出完成", "success");
    } catch (e) {
      console.error(e);
      setErrorMsg("导出失败");
      setStage("preview");
    }
  };

  const saveSettings = (newConfig) => {
    saveConfig(newConfig);
    setShowSettings(false);
    addLog("系统", "API 设置已更新", "success");
  };

  const renderInputSection = () => (
    <div className="max-w-3xl mx-auto mt-20 animate-fade-in px-4">
      <div className="text-center mb-12 space-y-4">
        <h1 className={`text-5xl font-extrabold tracking-tight ${THEME.text}`}>
          微微幻灯片
          <span
            className={`block mt-2 text-xl font-normal ${THEME.textSecondary} tracking-normal`}
          >
            智能排版 · 极简美学 · 视觉叙事
          </span>
        </h1>
      </div>

      <div
        className={`${THEME.card} rounded-2xl ${THEME.shadow} border ${THEME.border} p-2 mb-8 flex gap-2 w-fit mx-auto ring-1 ${isDark ? "ring-slate-800" : "ring-slate-100"}`}
      >
        <button
          onClick={() => setInputMode("topic")}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl transition-all font-medium ${
            inputMode === "topic"
              ? `${isDark ? "bg-teal-500/10 text-teal-400" : "bg-teal-50 text-teal-700"} shadow-sm`
              : `${THEME.textMuted} hover:${THEME.text} hover:${THEME.bg}`
          }`}
        >
          <Sparkles
            size={18}
            className={inputMode === "topic" ? THEME.accent : ""}
          />{" "}
          AI 灵感生成
        </button>
        <button
          onClick={() => setInputMode("text")}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl transition-all font-medium ${
            inputMode === "text"
              ? `${isDark ? "bg-teal-500/10 text-teal-400" : "bg-teal-50 text-teal-700"} shadow-sm`
              : `${THEME.textMuted} hover:${THEME.text} hover:${THEME.bg}`
          }`}
        >
          <FileText
            size={18}
            className={inputMode === "text" ? THEME.accent : ""}
          />{" "}
          文本转 PPT
        </button>
      </div>

      <div
        className={`${THEME.card} rounded-2xl shadow-sm border ${THEME.border} overflow-hidden transition-shadow hover:shadow-md`}
      >
        <div className="p-8 space-y-8">
          {inputMode === "topic" ? (
            <input
              className={`w-full bg-transparent text-2xl font-medium ${THEME.text} ${isDark ? "placeholder:text-slate-600" : "placeholder:text-slate-400"} border-b ${THEME.border} pb-4 focus:outline-none transition-colors`}
              placeholder="输入主题，例如：2026年全球咖啡市场趋势..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
            />
          ) : (
            <textarea
              className={`w-full bg-transparent text-lg ${THEME.text} ${isDark ? "placeholder:text-slate-600" : "placeholder:text-slate-400"} min-h-[160px] resize-none focus:outline-none border-b ${THEME.border} transition-colors leading-relaxed`}
              placeholder="在此粘贴你的文章、报告大纲或会议记录..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
          )}

          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-6">
              <div className={`flex items-center gap-2 ${THEME.textMuted}`}>
                <Sliders size={18} />
                <span className="text-sm font-medium">生成页数</span>
              </div>
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min="3"
                  max="15"
                  step="1"
                  value={targetSlideCount}
                  onChange={(e) =>
                    setTargetSlideCount(parseInt(e.target.value))
                  }
                  className={`w-40 h-1.5 ${THEME.border.replace("border-", "bg-")} rounded-lg appearance-none cursor-pointer accent-teal-500 hover:accent-teal-600`}
                />
                <span
                  className={`${THEME.bg} ${THEME.accent} px-3 py-1 rounded-md font-mono font-bold text-sm min-w-[3.5rem] text-center border ${THEME.border} shadow-sm`}
                >
                  {targetSlideCount}P
                </span>
              </div>
            </div>

            <button
              onClick={handleAnalyze}
              disabled={!inputValue.trim()}
              className={`${THEME.accentBg} ${THEME.accentHover} text-white px-8 py-3.5 rounded-xl font-bold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-teal-500/20`}
            >
              {stage === "analyzing" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}{" "}
              开始构建
            </button>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div
          className={`mt-6 ${THEME.error} text-center flex items-center justify-center gap-2 animate-bounce bg-rose-500/10 py-2 rounded-lg border border-rose-500/20 w-fit mx-auto px-6`}
        >
          <AlertCircle size={18} />
          {errorMsg}
        </div>
      )}

      <footer className={`mt-16 text-center ${THEME.textMuted} text-sm`}>
        <div className="flex items-center justify-center gap-4">
          <a
            href="https://github.com/uniqueww/unique-ppt"
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-1.5 hover:${THEME.accent} transition-colors`}
          >
            <Github size={16} />
            GitHub
          </a>
          <span className={isDark ? "text-slate-700" : "text-slate-300"}>
            |
          </span>
          <span>
            Made by{" "}
            <a
              href="https://github.com/uniqueww"
              target="_blank"
              rel="noopener noreferrer"
              className={`hover:${THEME.accent} transition-colors`}
            >
              uniqueww
            </a>
          </span>
        </div>
      </footer>
    </div>
  );

  const renderEditorSection = () => (
    <div className="max-w-6xl mx-auto py-8 animate-fade-in h-[calc(100vh-100px)] flex flex-col">
      <div className="flex justify-between items-center mb-6 px-2">
        <div className="space-y-1">
          <h2
            className={`text-2xl font-bold ${THEME.text} flex items-center gap-2`}
          >
            <Edit3 className={THEME.accent} size={24} /> 大纲与排版修订
          </h2>
          <p className={`${THEME.textMuted} text-sm`}>
            点击文字可直接修改。使用工具栏重新生成内容。
          </p>
        </div>
        <button
          onClick={handleBatchGeneration}
          className={`${THEME.accentBg} ${THEME.accentHover} text-white px-6 py-2.5 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-teal-500/20 transition-all active:scale-95`}
        >
          <ImageIcon size={20} /> 确认并生成配图
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-2 space-y-4 custom-scrollbar pb-20">
        {slides.map((slide, idx) => (
          <div
            key={idx}
            className={`${THEME.card} border ${THEME.border} rounded-2xl p-6 flex gap-8 group hover:border-teal-500/30 ${THEME.shadowHover} transition-all relative overflow-hidden`}
          >
            <div
              className={`${isDark ? "text-slate-700" : "text-slate-300"} font-mono text-2xl font-bold pt-1 select-none w-10 text-center`}
            >
              {String(idx + 1).padStart(2, "0")}
            </div>

            <div className="flex-1 space-y-5">
              <div className="flex items-center gap-4">
                <input
                  value={slide.title}
                  onChange={(e) => {
                    const newSlides = [...slides];
                    newSlides[idx].title = e.target.value;
                    setSlides(newSlides);
                  }}
                  className={`flex-1 bg-transparent text-xl font-bold ${THEME.text} border-b border-transparent hover:border-slate-200 focus:outline-none transition-colors pb-1`}
                />
                <button
                  onClick={() => rewriteSlideContent(idx)}
                  disabled={regeneratingIds[slide.id] === "text"}
                  className={`${THEME.textMuted} p-2 rounded-lg ${isDark ? "hover:bg-teal-500/10 hover:text-teal-400" : "hover:bg-teal-50 hover:text-teal-600"} transition-colors`}
                  title="重新生成文案"
                >
                  {regeneratingIds[slide.id] === "text" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Wand2 size={18} />
                  )}
                </button>
              </div>

              <textarea
                value={slide.content.join("\n")}
                onChange={(e) => {
                  const newSlides = [...slides];
                  newSlides[idx].content = e.target.value.split("\n");
                  setSlides(newSlides);
                }}
                className={`w-full ${isDark ? "bg-slate-800/50" : "bg-slate-50"} ${THEME.textSecondary} text-sm leading-relaxed border-l-2 ${THEME.border} pl-4 focus:outline-none resize-none h-28 rounded-r-lg transition-colors py-2`}
              />

              <div
                className={`pt-4 border-t ${THEME.border} flex items-center gap-4`}
              >
                <span
                  className={`text-xs ${THEME.textMuted} uppercase font-bold tracking-wider flex items-center gap-1`}
                >
                  <Layout size={12} /> 布局
                </span>
                <div className="flex gap-2 flex-wrap">
                  {Object.values(LAYOUTS).map((layout) => (
                    <button
                      key={layout.id}
                      onClick={() => {
                        const newSlides = [...slides];
                        newSlides[idx].layout = layout.id;
                        setSlides(newSlides);
                      }}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        slide.layout === layout.id
                          ? `${isDark ? "bg-teal-500/10 border-teal-500/30 text-teal-400" : "bg-teal-50 border-teal-200 text-teal-700"} shadow-sm`
                          : `${THEME.border} ${THEME.textMuted} ${isDark ? "hover:bg-slate-800" : "hover:bg-slate-50"}`
                      }`}
                    >
                      {layout.icon}
                      {layout.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div
              className={`w-64 ${isDark ? "bg-slate-800/50" : "bg-slate-50"} rounded-xl p-4 text-xs ${THEME.textSecondary} border ${THEME.border} flex flex-col`}
            >
              <span
                className={`font-bold mb-3 ${THEME.textMuted} flex items-center gap-2 uppercase tracking-wide`}
              >
                <Sparkles size={12} /> 图像提示词
              </span>
              <textarea
                value={slide.imagePrompt}
                onChange={(e) => {
                  const newSlides = [...slides];
                  newSlides[idx].imagePrompt = e.target.value;
                  setSlides(newSlides);
                }}
                className={`flex-1 bg-transparent resize-none focus:outline-none ${THEME.textSecondary} leading-relaxed`}
                placeholder="英文图像描述..."
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderGenerationLoader = () => (
    <div className="max-w-2xl mx-auto mt-32 text-center space-y-10 animate-fade-in">
      <div className="relative w-40 h-40 mx-auto">
        <div
          className={`absolute inset-0 border-4 ${isDark ? "border-slate-800" : "border-slate-100"} rounded-full`}
        ></div>
        <div className="absolute inset-0 border-4 border-teal-500 rounded-full border-t-transparent animate-spin"></div>
        <div
          className={`absolute inset-0 flex items-center justify-center font-bold text-3xl ${THEME.accent} font-mono`}
        >
          {Math.round((currentProcessIndex / slides.length) * 100)}%
        </div>
      </div>

      <div className="space-y-3">
        <h3 className={`text-2xl font-bold ${THEME.text}`}>
          正在渲染高保真幻灯片...
        </h3>
        <p className={THEME.textSecondary}>
          正在为第{" "}
          <span className={`font-bold ${THEME.accent}`}>
            {currentProcessIndex + 1}
          </span>{" "}
          页生成{" "}
          {LAYOUTS[
            Object.keys(LAYOUTS).find(
              (k) => LAYOUTS[k].id === slides[currentProcessIndex]?.layout,
            )
          ]?.name || "配图"}
        </p>
      </div>

      <div
        className={`${THEME.card} rounded-xl p-6 h-48 overflow-y-auto text-left font-mono text-sm border ${THEME.border} shadow-inner`}
      >
        {logs.map((log, i) => (
          <div key={i} className="mb-2 last:mb-0">
            <span className={`${THEME.textMuted} mr-3 text-xs`}>
              [{log.time}]
            </span>
            <span
              className={
                log.type === "error" ? "text-rose-500" : "text-emerald-500"
              }
            >
              {log.message}
            </span>
          </div>
        ))}
        <div ref={(el) => el?.scrollIntoView({ behavior: "smooth" })} />
      </div>
    </div>
  );

  const handleLogin = () => {
    if (login(password)) {
      setAuthError(false);
    } else {
      setAuthError(true);
    }
  };

  if (requiresAuth && !isAuthenticated) {
    return (
      <div
        className={`min-h-screen ${THEME.bg} ${THEME.text} font-sans flex items-center justify-center`}
      >
        <div
          className={`${THEME.card} border ${THEME.border} rounded-2xl p-8 w-full max-w-sm shadow-xl`}
        >
          <div className="text-center mb-8">
            <div className="bg-gradient-to-tr from-teal-400 to-emerald-500 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg shadow-teal-500/20 text-white mx-auto mb-4">
              <Sparkles size={28} fill="currentColor" />
            </div>
            <h1 className={`text-2xl font-bold ${THEME.text}`}>微微幻灯片</h1>
            <p className={`${THEME.textMuted} mt-2`}>请输入访问密码</p>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="输入密码..."
            className={`w-full px-4 py-3 rounded-xl ${THEME.bg} border ${authError ? "border-rose-500" : THEME.border} ${THEME.text} focus:outline-none focus:border-teal-500 transition-colors`}
          />
          {authError && (
            <p className="text-rose-500 text-sm mt-2 flex items-center gap-1">
              <AlertCircle size={14} /> 密码错误
            </p>
          )}
          <button
            onClick={handleLogin}
            className={`w-full mt-4 ${THEME.accentBg} ${THEME.accentHover} text-white py-3 rounded-xl font-bold transition-all active:scale-95`}
          >
            进入
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen ${THEME.bg} ${THEME.text} font-sans selection:bg-teal-500/20 overflow-hidden transition-colors duration-300`}
    >
      <header
        className={`h-16 border-b ${THEME.border} ${THEME.header} backdrop-blur-md sticky top-0 z-50 px-6 flex items-center justify-between ${THEME.shadow}`}
      >
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-teal-400 to-emerald-500 w-9 h-9 rounded-xl flex items-center justify-center shadow-lg shadow-teal-500/20 text-white">
            <Sparkles size={18} fill="currentColor" />
          </div>
          <div className="flex flex-col leading-none">
            <span className={`font-bold tracking-tight text-lg ${THEME.text}`}>
              微微幻灯片
            </span>
            <span
              className={`text-[10px] ${THEME.textMuted} font-medium tracking-wider`}
            >
              unique-ppt
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className={`${THEME.textSecondary} ${isDark ? "hover:text-amber-400 hover:bg-amber-500/10" : "hover:text-teal-600 hover:bg-teal-50"} p-2 rounded-lg transition-colors`}
            title={isDark ? "切换浅色模式" : "切换深色模式"}
          >
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className={`${THEME.textSecondary} ${isDark ? "hover:text-teal-400 hover:bg-teal-500/10" : "hover:text-teal-600 hover:bg-teal-50"} p-2 rounded-lg transition-colors`}
            title="API 设置"
          >
            <Settings size={20} />
          </button>
          <div
            className={`h-4 w-px ${THEME.border.replace("border-", "bg-")}`}
          ></div>
          <span
            className={`text-xs font-mono font-bold flex items-center gap-1.5 ${pptLibReady ? THEME.success : "text-orange-400"}`}
          >
            <div
              className={`w-2 h-2 rounded-full ${pptLibReady ? "bg-emerald-500" : "bg-orange-400"}`}
            ></div>
            {pptLibReady ? "就绪" : "加载中"}
          </span>
        </div>
      </header>

      <main className="px-6 relative z-10">
        {stage === "input" && renderInputSection()}
        {stage === "analyzing" && (
          <div className="mt-40 text-center">
            <Loader2
              className={`w-12 h-12 ${THEME.accent} animate-spin mx-auto mb-6`}
            />
            <h2 className={`text-xl font-bold ${THEME.textSecondary} mb-2`}>
              正在拆解文本结构...
            </h2>
            <p className={`${THEME.textMuted} animate-pulse`}>
              AI 正在规划 {targetSlideCount} 页幻灯片大纲
            </p>
          </div>
        )}
        {stage === "edit_outline" && renderEditorSection()}
        {stage === "generating_images" && renderGenerationLoader()}
        {(stage === "preview" || stage === "exporting") && (
          <PreviewSection
            slides={slides}
            setSlides={setSlides}
            previewIndex={previewIndex}
            setPreviewIndex={setPreviewIndex}
            stage={stage}
            setStage={setStage}
            handleExport={handleExport}
            regenerateSlideImage={regenerateSlideImage}
            isDark={isDark}
          />
        )}
      </main>

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        config={apiConfig}
        onSave={saveSettings}
        isDark={isDark}
      />
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: ${isDark ? "#475569" : "#cbd5e1"}; border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: ${isDark ? "#64748b" : "#94a3b8"}; }
        
        textarea::-webkit-scrollbar { width: 6px; }
        textarea::-webkit-scrollbar-track { background: transparent; }
        textarea::-webkit-scrollbar-thumb { background: ${isDark ? "#475569" : "#cbd5e1"}; border-radius: 3px; }
        textarea::-webkit-scrollbar-thumb:hover { background: ${isDark ? "#64748b" : "#94a3b8"}; }
        
        input::-webkit-scrollbar { width: 6px; }
        input::-webkit-scrollbar-track { background: transparent; }
        input::-webkit-scrollbar-thumb { background: ${isDark ? "#475569" : "#cbd5e1"}; border-radius: 3px; }
      `}</style>
    </div>
  );
}
