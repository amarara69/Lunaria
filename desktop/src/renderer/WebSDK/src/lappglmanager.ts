/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

export let canvas: HTMLCanvasElement | null = null;
export let gl: WebGLRenderingContext | null = null;
export let s_instance: LAppGlManager | null = null;
import { resolveActiveLive2DCanvas } from "../../src/runtime/live2d-canvas-binding-utils.ts";
import { resolveLive2DGlContext } from "../../src/runtime/live2d-gl-context-utils.ts";
/**
 * Cubism SDKのサンプルで使用するWebGLを管理するクラス
 */
export class LAppGlManager {
  /**
   * クラスのインスタンス（シングルトン）を返す。
   * インスタンスが生成されていない場合は内部でインスタンスを生成する。
   *
   * @return クラスのインスタンス
   */
  public static getInstance(): LAppGlManager {
    if (s_instance == null) {
      s_instance = new LAppGlManager();
    }

    s_instance.bindCanvas();

    return s_instance;
  }

  /**
   * クラスのインスタンス（シングルトン）を解放する。
   */
  public static releaseInstance(): void {
    if (s_instance != null) {
      s_instance.release();
    }

    s_instance = null;
  }

  constructor() {
    this.bindCanvas();
  }

  private bindCanvas(): void {
    const nextCanvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const activeCanvas = resolveActiveLive2DCanvas({
      currentCanvas: canvas,
      nextCanvas,
    });

    if (!activeCanvas) {
      canvas = null;
      gl = null;
      console.warn("Canvas element not found during LAppGlManager initialization");
      return;
    }

    if (canvas !== activeCanvas || !gl) {
      canvas = activeCanvas;
      gl = resolveLive2DGlContext(canvas);
    }

    if (!gl) {
      // gl初期化失敗
      alert("Cannot initialize WebGL. This browser does not support.");
      document.body.innerHTML =
        "This browser does not support the <code>&lt;canvas&gt;</code> element.";
    }
  }

  /**
   * 解放する。
   */
  public release(): void {
    canvas = null;
    gl = null;
  }
}
