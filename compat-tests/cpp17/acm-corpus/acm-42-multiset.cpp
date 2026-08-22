#include <bits/stdc++.h>
using namespace std;
int main(){multiset<int>s{3,1,3};s.erase(s.find(3));cout<<s.size()<<" "<<*s.begin()<<"\n";}
