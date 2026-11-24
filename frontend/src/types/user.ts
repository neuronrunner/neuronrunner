export interface IUser {
  uuid: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  bio?: string;
  profile_picture?: string;
  profile_picture_blur_data_url?: string;
  runs?: number;
  followers_count?: number;
  following_count?: number;
  is_following?: boolean;
  is_staff?: boolean;
  is_superuser?: boolean;
}