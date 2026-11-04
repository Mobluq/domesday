/**
 * The TensorFlow.js side of the live detector. detector.ts imports this module dynamically
 * when the camera opens, so TensorFlow and COCO-SSD land in their own lazily loaded chunk
 * and never in the main bundle.
 */
import { load, type ObjectDetection } from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs-backend-webgl';
import { enableProdMode, getKernel, ready, registerKernel, setBackend } from '@tensorflow/tfjs-core';
// COCO-SSD switches to the 'cpu' backend on every detect() for its non-max suppression step,
// so a 'cpu' backend must be registered. Register it without its 150-odd kernels, plus the
// one kernel that step uses. The models run on WebGL.
import '@tensorflow/tfjs-backend-cpu/dist/base';
import { nonMaxSuppressionV3Config } from '@tensorflow/tfjs-backend-cpu/dist/kernels/NonMaxSuppressionV3';

/** Load COCO-SSD (lite MobileNet v2) from modelUrl on the WebGL backend. Throws when WebGL is not available. */
export async function loadCocoSsd(modelUrl: string): Promise<ObjectDetection> {
  if (!getKernel(nonMaxSuppressionV3Config.kernelName, 'cpu')) registerKernel(nonMaxSuppressionV3Config);
  enableProdMode();
  if (!(await setBackend('webgl'))) throw new Error('WebGL is not available on this device.');
  await ready();
  return load({ base: 'lite_mobilenet_v2', modelUrl });
}
