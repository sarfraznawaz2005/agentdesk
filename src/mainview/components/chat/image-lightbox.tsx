import { useEffect } from "react";
import { createPortal } from "react-dom";

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return createPortal(
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
			onClick={onClose}
		>
			<img
				src={src}
				alt={alt}
				className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
			/>
		</div>,
		document.body,
	);
}
