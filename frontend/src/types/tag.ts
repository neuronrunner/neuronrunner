export type UploadComponent = "base" | "clip_l" | "t5xxl" | "vae";

export interface Tag {
    uuid: string;
    name: string;
    model: string;
    created_at: string;
    size: number | null;
    order: number;
    files: {
        uuid: string;
        tag: string;
        original_name: string;
        storage_name?: string;
        component?: UploadComponent;
        file_size: number | null;
        created_at: string;
    }[];
    gpu?: string;
    gpu_display?: string;
    is_built?: boolean;
    is_tested?: boolean;
    is_external?: boolean;
    external_url?: string | null;
    external_model_id?: string | null;
    external_api_key?: string | null;
}
