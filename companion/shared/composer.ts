export type ComposerImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ComposerState = {
  text: string;
  images: ComposerImage[];
  isComposing: boolean;
};

export type SubmitIntent = {
  text: string;
  images: ComposerImage[];
};

export function createComposerState(): ComposerState {
  return {
    text: "",
    images: [],
    isComposing: false
  };
}

export function setComposerText(state: ComposerState, text: string): ComposerState {
  return {
    ...state,
    text
  };
}

export function setComposing(state: ComposerState, isComposing: boolean): ComposerState {
  return {
    ...state,
    isComposing
  };
}

export function addComposerImages(state: ComposerState, images: ComposerImage[]): ComposerState {
  const nextImages = [...state.images];

  for (const image of images) {
    if (!nextImages.some((existing) => existing.id === image.id)) {
      nextImages.push(image);
    }
  }

  return {
    ...state,
    images: nextImages
  };
}

export function removeComposerImage(state: ComposerState, imageId: string): ComposerState {
  return {
    ...state,
    images: state.images.filter((image) => image.id !== imageId)
  };
}

export function submitComposer(state: ComposerState): { state: ComposerState; intent?: SubmitIntent } {
  if (state.isComposing) {
    return { state };
  }

  const text = state.text.trim();
  if (text.length === 0 && state.images.length === 0) {
    return { state };
  }

  return {
    state: createComposerState(),
    intent: {
      text,
      images: state.images
    }
  };
}

export function shouldSubmitFromKeyboard(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

export function imageId(name: string, size: number, lastModified: number): string {
  return `${name}:${size}:${lastModified}`;
}
