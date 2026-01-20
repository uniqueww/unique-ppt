import { useState, useEffect } from "react";
import { DEFAULT_API_CONFIG } from "@/constants";

let SECRET_CONFIG = null;
let ACCESS_PASSWORD = null;
try {
  const secret = require("@/constants/secret");
  SECRET_CONFIG = secret.SECRET_CONFIG;
  ACCESS_PASSWORD = secret.ACCESS_PASSWORD;
} catch (e) {
  // secret.js 不存在时使用默认配置
}

const STORAGE_KEY = "uniquePpt_api_config";
const THEME_KEY = "uniquePpt_theme";
const AUTH_KEY = "uniquePpt_authenticated";

const getDefaultConfig = () => {
  if (SECRET_CONFIG) {
    return {
      text: {
        provider: SECRET_CONFIG.text.provider || "openai",
        protocol: "openai",
        baseUrl: SECRET_CONFIG.text.baseUrl || "",
        model: SECRET_CONFIG.text.model || "",
        apiKey: SECRET_CONFIG.text.apiKey || "",
      },
      image: {
        provider: SECRET_CONFIG.image.provider || "openai",
        protocol: "openai_image",
        baseUrl: SECRET_CONFIG.image.baseUrl || "",
        model: SECRET_CONFIG.image.model || "",
        apiKey: SECRET_CONFIG.image.apiKey || "",
      },
    };
  }
  return DEFAULT_API_CONFIG;
};

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    if (!ACCESS_PASSWORD) return true;
    return localStorage.getItem(AUTH_KEY) === "true";
  });

  const login = (password) => {
    if (password === ACCESS_PASSWORD) {
      setIsAuthenticated(true);
      localStorage.setItem(AUTH_KEY, "true");
      return true;
    }
    return false;
  };

  const requiresAuth = !!ACCESS_PASSWORD;

  return { isAuthenticated, login, requiresAuth };
}

export function useTheme() {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved !== null) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  }, [isDark]);

  const toggleTheme = () => setIsDark((prev) => !prev);

  return { isDark, toggleTheme };
}

export function useApiConfig() {
  const [apiConfig, setApiConfig] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!parsed.text.protocol) parsed.text.protocol = "openai";
      if (!parsed.image.protocol) parsed.image.protocol = "openai_image";
      return parsed;
    }
    return getDefaultConfig();
  });

  const saveConfig = (newConfig) => {
    setApiConfig(newConfig);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
  };

  return { apiConfig, saveConfig };
}

export function usePptLib() {
  const [pptLibReady, setPptLibReady] = useState(false);

  useEffect(() => {
    if (window.PptxGenJS) {
      setPptLibReady(true);
    } else {
      const script = document.createElement("script");
      script.src =
        "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js";
      script.async = true;
      script.onload = () => setPptLibReady(true);
      document.body.appendChild(script);
    }
  }, []);

  return pptLibReady;
}

export function useCooldown() {
  const [cooldownTime, setCooldownTime] = useState(0);

  useEffect(() => {
    if (cooldownTime <= 0) return;
    const interval = setInterval(() => setCooldownTime((p) => p - 1), 1000);
    return () => clearInterval(interval);
  }, [cooldownTime]);

  return { cooldownTime, setCooldownTime };
}

export function useLogs() {
  const [logs, setLogs] = useState([]);

  const addLog = (source, message, type = "info") => {
    setLogs((prev) => [
      ...prev.slice(-4),
      { source, message, type, time: new Date().toLocaleTimeString() },
    ]);
  };

  return { logs, addLog };
}
