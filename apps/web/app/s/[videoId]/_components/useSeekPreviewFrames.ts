"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	nearestPooledTime,
	quantizePoolTime,
	rememberFrame,
} from "./timeline/filmstrip-math";
import {
	seekForCapture,
	waitForVideoMetadata,
} from "./timeline/useFilmstripFrames";
import { captureVideoFrameDataUrl } from "./video-frame-thumbnail";

const PREVIEW_WIDTH = 224;
const PREVIEW_HEIGHT = 128;
const PREVIEW_MAX_SLOTS = 400;
const PREVIEW_FRAME_MAX = 240;

export const seekPreviewQuantum = (duration: number): number =>
	Number.isFinite(duration) && duration > 0
		? Math.max(1, duration / PREVIEW_MAX_SLOTS)
		: 1;

export const seekPreviewBorrowTolerance = (duration: number): number =>
	Math.max(seekPreviewQuantum(duration) * 4, duration / 40);

interface PreviewRunner {
	video: HTMLVideoElement | null;
	running: boolean;
	cancelled: boolean;
}

interface UseSeekPreviewFramesOptions {
	src: string | null;
	duration: number;
}

/**
 * Frames come from a second, hidden video so hovering never moves the one
 * being watched. The seek tooltip calls the getter synchronously during
 * render, so a captured frame has to surface as a new getter identity.
 */
export function useSeekPreviewFrames({
	src,
	duration,
}: UseSeekPreviewFramesOptions) {
	const [version, setVersion] = useState(0);
	const framesRef = useRef(new Map<number, string>());
	const targetRef = useRef<number | null>(null);
	const runnerRef = useRef<PreviewRunner | null>(null);

	useEffect(() => {
		framesRef.current = new Map();
		targetRef.current = null;
		if (!src) return;
		const runner: PreviewRunner = {
			video: null,
			running: false,
			cancelled: false,
		};
		runnerRef.current = runner;
		return () => {
			runner.cancelled = true;
			if (runner.video) {
				runner.video.removeAttribute("src");
				runner.video.load();
				runner.video = null;
			}
			if (runnerRef.current === runner) runnerRef.current = null;
		};
	}, [src]);

	const pump = useCallback(async () => {
		const runner = runnerRef.current;
		if (!runner || runner.running || !src) return;
		runner.running = true;
		try {
			if (!runner.video) {
				const video = document.createElement("video");
				video.crossOrigin = "anonymous";
				video.muted = true;
				video.playsInline = true;
				video.preload = "metadata";
				video.src = src;
				video.load();
				runner.video = video;
				const ready = await waitForVideoMetadata(video);
				if (runner.cancelled || !ready) return;
			}

			let slot = targetRef.current;
			while (
				slot !== null &&
				!runner.cancelled &&
				runner.video &&
				!framesRef.current.has(slot)
			) {
				const seeked = await seekForCapture(runner.video, slot);
				if (runner.cancelled || !runner.video) return;
				const frame = seeked
					? captureVideoFrameDataUrl({
							video: runner.video,
							width: PREVIEW_WIDTH,
							height: PREVIEW_HEIGHT,
							quality: 0.7,
						})
					: undefined;
				if (!frame) return;
				rememberFrame(framesRef.current, slot, frame, PREVIEW_FRAME_MAX);
				setVersion((value) => value + 1);
				slot = targetRef.current;
			}
		} finally {
			runner.running = false;
		}
	}, [src]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` changes the getter identity so the tooltip re-renders when a frame lands
	return useCallback(
		(time: number): string | undefined => {
			if (!src || !Number.isFinite(duration) || duration <= 0) return undefined;
			const slot = quantizePoolTime(
				Math.min(time, duration),
				seekPreviewQuantum(duration),
			);
			const frames = framesRef.current;
			const exact = frames.get(slot);
			if (exact) return exact;

			if (targetRef.current !== slot) {
				targetRef.current = slot;
				void pump();
			}

			const nearest = nearestPooledTime(
				frames.keys(),
				slot,
				seekPreviewBorrowTolerance(duration),
			);
			return nearest === null ? undefined : frames.get(nearest);
		},
		[src, duration, pump, version],
	);
}
