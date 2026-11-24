from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.forms import UserCreationForm

from .models import OTP

User = get_user_model()


class AdminUserCreationForm(UserCreationForm):
    class Meta(UserCreationForm.Meta):
        model = User
        fields = ("username", "email")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        existing_help_text = self.fields["password1"].help_text or ""
        self.fields["password1"].help_text = (
            f'{existing_help_text}<br><button type="button" class="button" id="generate-random-password-btn">Random Password</button> '
            f'<button type="button" class="button" id="toggle-password-visibility-btn">Show Password</button>'
        )


class CustomUserAdmin(UserAdmin):
    add_form = AdminUserCreationForm
    list_display = ('username', 'email', 'first_name', 'last_name', 'is_staff', 'is_active')
    search_fields = ('username', 'email', 'first_name', 'last_name')
    list_filter = ('is_staff', 'is_active', 'date_joined')
    add_fieldsets = (
        (
            None,
            {
                'classes': ('wide',),
                'fields': ('username', 'email', 'password1', 'password2'),
            },
        ),
    )
    fieldsets = tuple(UserAdmin.fieldsets or ()) + (
        ('Profile Info', {'fields': ('bio', 'profile_picture')}),
    )

    class Media:
        js = ('authentication/admin/random_password.js',)

class OTPAdmin(admin.ModelAdmin):
    list_display = ('email', 'otp', 'created_at')
    search_fields = ('email',)
    list_filter = ('created_at',)
    readonly_fields = ('created_at',)

admin.site.register(User, CustomUserAdmin)
admin.site.register(OTP, OTPAdmin)
