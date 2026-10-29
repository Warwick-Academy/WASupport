import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';

type Props = {
  onCapture: (photo: File) => void;
};

export default function CameraCaptureButton({ onCapture }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    let cameraStream: MediaStream | null = null;
    setCameraError(null);

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera access is not available in this browser. Choose a picture from files instead.');
        return;
      }
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!active) {
          cameraStream.getTracks().forEach((track) => track.stop());
          return;
        }
        setStream(cameraStream);
      } catch (error) {
        if (active) {
          const reason = error instanceof Error ? error.message : 'Camera permission was denied.';
          setCameraError(`Could not access the camera: ${reason} Choose a picture from files instead.`);
        }
      }
    })();

    return () => {
      active = false;
      cameraStream?.getTracks().forEach((track) => track.stop());
    };
  }, [isOpen]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  function closeCamera() {
    setIsOpen(false);
    setStream(null);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setCameraError('The camera is not ready yet. Please wait a moment and try again.');
      return;
    }

    const scale = Math.min(1, 2560 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      setCameraError('Could not capture the image. Please choose a picture from files instead.');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setCameraError('Could not capture the image. Please choose a picture from files instead.');
          return;
        }
        onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' }));
        closeCamera();
      },
      'image/jpeg',
      0.9,
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="btn-primary inline-flex items-center gap-2 px-4 py-2.5"
      >
        <Camera aria-hidden="true" size={18} />
        Take a photo
      </button>
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCamera();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="camera-dialog-title"
            className="w-full max-w-2xl space-y-4 rounded-xl bg-white p-5 shadow-xl"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 id="camera-dialog-title" className="text-lg font-semibold text-brand-navy">
                Take a photo
              </h2>
              <button type="button" onClick={closeCamera} className="btn-ghost">
                Cancel
              </button>
            </div>
            {cameraError ? (
              <p role="alert" className="alert-error">{cameraError}</p>
            ) : (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="max-h-[65vh] w-full rounded-lg bg-slate-950 object-contain"
              />
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={capturePhoto}
                disabled={!stream || !!cameraError}
                className="btn-primary"
              >
                Capture photo
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
